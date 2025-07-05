// delegators-cleanup.js
const {
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const { exec } = require('child_process');
const { Pool } = require('pg');
const cron = require('node-cron');

const CLIENT_PATH = process.env.CONCORDIUM_CLIENT_PATH;
const DELEGATOR_ROLE_ID = process.env.DELEGATOR_ROLE_ID;
const GRPC_IP = process.env.GRPC_IP;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const MOD_LOGS_CHANNEL_ID = process.env.MOD_LOGS_CHANNEL_ID;

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT
});

const cleanupState = new Map();

async function logToModChannel(client, content) {
    try {
        const channelId = MOD_LOGS_CHANNEL_ID;
        const channel = await client.channels.fetch(channelId);
        if (channel?.isTextBased?.()) {
            await channel.send({ content });
        }
    } catch (err) {
        console.error("Failed to log to moderation channel:", err);
    }
}

async function handleCleanupDelegators(interaction, options = {}) {
    const isAuto = options?.autoConfirm === true;

    if (!isAuto && !interaction.member.permissions.has('Administrator')) {
        return interaction.reply({
            content: 'This command requires administrator permissions',
            flags: MessageFlags.Ephemeral
        });
    }

    if (!isAuto) await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const dbResult = await pool.query(
            "SELECT discord_id, wallet_address FROM verifications WHERE role_type = 'Delegator'"
        );

        const guild = await interaction.guild.fetch?.() || interaction.guild;
        const inactive = [];

        for (const row of dbResult.rows) {
            const { discord_id, wallet_address } = row;

            const cmd = `${CLIENT_PATH} account show ${wallet_address} --grpc-ip ${GRPC_IP} --secure`;

            // Delegator activity check with staked amount verification
            const isInactive = await new Promise((resolve) => {
                exec(cmd, (err, stdout) => {
                    if (err || !stdout) return resolve(false);
                    const output = stdout.trim();

                    // If not a validator or delegator, mark as inactive
                    if (output.includes('Validator or delegator: no')) return resolve(true);

                    // If not delegating at all, mark as inactive
                    if (output.includes('Delegation: not delegating')) return resolve(true);

                    // If there is a delegation target (pool OR passive), always check the staked amount
                    const delegationTargetMatch = output.match(/Delegation target:\s*(.+)/);
                    if (delegationTargetMatch) {
                        const match = output.match(/Staked amount:\s*([0-9.]+)\s*CCD/);
                        if (match) {
                            const stakedAmount = parseFloat(match[1]);
                            return resolve(stakedAmount < 1000);
                        }
                        // If can't parse amount, consider as active just in case
                        return resolve(false);
                    }

                    // By default, consider as active
                    return resolve(false);
                });
            });

            if (isInactive) {
                const username = await guild.members.fetch(discord_id)
                    .then(m => m.user.tag)
                    .catch(() => 'Unknown User');
                inactive.push({ discord_id, wallet_address, username });
            }
        }

        if (inactive.length === 0) {
            const msg = '✅ All registered delegators are currently active.';
            if (isAuto) {
                await logToModChannel(interaction.client, `🧹 **Auto-cleanup report**\n${msg}`);
            }
            return interaction.editReply?.({ content: msg }) ||
                interaction.reply?.({ content: msg });
        }

        if (isAuto) {
            const role = await guild.roles.fetch(DELEGATOR_ROLE_ID);
            let removed = 0;
            let logLines = [];

            for (const i of inactive) {
                try {
                    const userTag = await guild.members.fetch(i.discord_id)
                        .then(m => {
                            m.roles.remove(role);
                            return m.user.tag;
                        })
                        .catch(() => 'Unknown user');

                    await pool.query(
                        `DELETE FROM verifications 
                         WHERE wallet_address = $1 
                         AND role_type = 'Delegator'`,
                        [i.wallet_address]
                    );

                    logLines.push(`• ${userTag} — \`${i.wallet_address}\``);
                    removed++;
                } catch (err) {
                    console.error(`Failed to remove ${i.wallet_address}`, err);
                }
            }

            const logMessage = `🧹 **Auto-cleanup completed**\nRemoved ${removed} inactive delegators:\n` + logLines.join('\n');
            console.log(`[AUTO-DELEGATOR-CLEANUP]\n` + logMessage);
            await logToModChannel(interaction.client, logMessage);

            return interaction.editReply?.({ content: `✅ Auto-cleanup complete: ${removed} inactive delegators removed.` });
        }

        let listLines = [];
        let totalLength = 0;
        let maxLength = 1800;
        let truncatedCount = 0;

        for (const i of inactive) {
            const line = `• ${i.username} — \`${i.wallet_address}\``;
            if (totalLength + line.length + 1 > maxLength) {
                truncatedCount = inactive.length - listLines.length;
                break;
            }
            listLines.push(line);
            totalLength += line.length + 1;
        }

        if (truncatedCount > 0) {
            listLines.push(`...and ${truncatedCount} more users not shown`);
        }

        const listText = listLines.join('\n');

        cleanupState.set(interaction.user.id, inactive);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('confirm_delegator_cleanup')
                .setLabel('Confirm')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('cancel_delegator_cleanup')
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary)
        );

        await interaction.editReply({
            content: `⚠️ Found ${inactive.length} inactive delegators:\n\n${listText}\n\nDo you want to remove them?`,
            components: [row]
        });

        setTimeout(() => cleanupState.delete(interaction.user.id), 120000);
    } catch (error) {
        console.error('Delegator scan failed:', error);
        await interaction.editReply?.({
            content: '❌ Failed to evaluate delegators.'
        });
    }
}

async function handleCleanupDelegatorConfirmation(interaction) {
    if (!interaction.isButton()) return;

    const state = cleanupState.get(interaction.user.id);
    if (!state) return;

    try {
        await interaction.deferUpdate();

        if (interaction.customId === 'confirm_delegator_cleanup') {
            const guild = await interaction.guild.fetch();
            const role = await guild.roles.fetch(DELEGATOR_ROLE_ID);

            let removed = 0, failed = 0;

            for (const { discord_id, wallet_address } of state) {
                try {
                    await guild.members.fetch(discord_id)
                        .then(member => member.roles.remove(role))
                        .catch(() => null);

                    await pool.query(
                        `DELETE FROM verifications 
                         WHERE wallet_address = $1 
                         AND role_type = 'Delegator'`,
                        [wallet_address]
                    );

                    removed++;
                } catch (err) {
                    console.error(`Failed to remove ${wallet_address}`, err);
                    failed++;
                }
            }

            await interaction.editReply({
                content: `✅ Cleanup complete:\n• Removed: ${removed}\n• Failed: ${failed}`,
                components: []
            });

        } else {
            await interaction.editReply({
                content: '❎ Delegator cleanup cancelled.',
                components: []
            });
        }
    } catch (error) {
        console.error('Delegator confirmation failed:', error);
        await interaction.editReply({
            content: '❌ Error during cleanup.',
            components: []
        });
    } finally {
        cleanupState.delete(interaction.user.id);
    }
}

function startScheduledDelegatorCleanup(client) {
    cron.schedule("5 9 * * *", async () => {
        console.log("⏰ Running scheduled delegator cleanup (09:05 UTC)");

        try {
            const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
            const botMember = await guild.members.fetch(client.user.id);

            const fakeInteraction = {
                member: botMember,
                guild,
                deferReply: async () => {},
                editReply: async (data) =>
                    console.log(`[AUTO-DELEGATOR-CLEANUP] ${data?.content || '[No content]'}`),
                reply: async (data) =>
                    console.log(`[AUTO-DELEGATOR-REPLY] ${data?.content || '[No content]'}`),
                user: client.user,
                client: client
            };

            await handleCleanupDelegators(fakeInteraction, { autoConfirm: true });
        } catch (error) {
            console.error("❌ Scheduled delegator cleanup failed:", error);
        }
    }, {
        timezone: "UTC"
    });
}

module.exports = {
    handleCleanupDelegators,
    handleCleanupDelegatorConfirmation,
    startScheduledDelegatorCleanup
};