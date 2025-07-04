// validators-cleanup.js
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');
const { exec } = require('child_process');
const { Pool } = require('pg');
const cron = require('node-cron');

const CLIENT_PATH = process.env.CONCORDIUM_CLIENT_PATH;
const VALIDATOR_ROLE_ID = process.env.VALIDATOR_ROLE_ID;
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

// Temporary storage for confirmations
const cleanupState = new Map();

async function logToModChannel(client, message) {
    try {
        const channel = await client.channels.fetch(MOD_LOGS_CHANNEL_ID);
        if (channel) {
            await channel.send(message);
        }
    } catch (err) {
        console.error("Failed to send log to moderator channel:", err);
    }
}

async function isSuspendedValidator(walletAddress) {
    const cmd = `${CLIENT_PATH} account show ${walletAddress} --grpc-ip ${GRPC_IP} --secure`;
    try {
        const output = await new Promise((resolve, reject) => {
            exec(cmd, (err, stdout, stderr) => {
                if (err) return reject(stderr);
                resolve(stdout);
            });
        });

        return /This validator is suspended/i.test(output);
    } catch (error) {
        console.warn(`⚠️ Failed to check status for ${walletAddress}:`, error);
        return false;
    }
}

async function handleCleanupValidators(interaction, options = { autoConfirm: false }) {
    if (!interaction.member?.permissions?.has?.('Administrator') && interaction.user?.id !== interaction.client?.user?.id) {
        return interaction.reply?.({
            content: 'This command requires administrator permissions',
            flags: MessageFlags.Ephemeral
        });
    }

    try {
        await interaction.deferReply?.({ flags: MessageFlags.Ephemeral });

        const cmd = `${CLIENT_PATH} consensus show-parameters --include-bakers --grpc-ip ${GRPC_IP} --secure | awk 'NR>4 && NF {print $2}'`;

        exec(cmd, async (err, stdout, stderr) => {
            if (err) {
                console.error('Validator check failed:', stderr);
                return interaction.editReply?.({ content: 'Failed to fetch validators from blockchain' });
            }

            const activeValidators = new Set(
                stdout.trim()
                    .split('\n')
                    .filter(addr => addr.length > 0)
            );

            const dbResult = await pool.query(
                "SELECT discord_id, wallet_address FROM verifications WHERE role_type = 'Validator'"
            );

            const rawInactiveCandidates = dbResult.rows.filter(
                row => !activeValidators.has(row.wallet_address)
            );

            const suspendedValidators = [];
            const inactiveValidators = [];

            for (const row of rawInactiveCandidates) {
                const isSuspended = await isSuspendedValidator(row.wallet_address);
                if (isSuspended) {
                    suspendedValidators.push(row);
                } else {
                    inactiveValidators.push(row);
                }
            }

            const allInactive = [...inactiveValidators, ...suspendedValidators];

            if (allInactive.length === 0) {
                return interaction.editReply?.({ content: '✅ All registered validators are currently active.' });
            }

            if (options.autoConfirm) {
                const guild = await interaction.guild.fetch?.() || interaction.guild;
                const role = await guild.roles.fetch(VALIDATOR_ROLE_ID);

                let removed = 0;
                let logLines = [];

                for (const v of inactiveValidators) {
                    try {
                        const userTag = await guild.members.fetch(v.discord_id)
                            .then(m => {
                                m.roles.remove(role);
                                return m.user.tag;
                            })
                            .catch(() => 'Unknown user');

                        await pool.query(
                            `DELETE FROM verifications 
                             WHERE wallet_address = $1 
                             AND role_type = 'Validator'`,
                            [v.wallet_address]
                        );

                        logLines.push(`• ${userTag} — \`${v.wallet_address}\``);
                        removed++;
                    } catch (err) {
                        console.error(`Failed to remove ${v.wallet_address}`, err);
                    }
                }

                const logMessage = `🧹 **Auto-cleanup completed**
Removed ${removed} inactive validators:
` + logLines.join('\n');
                console.log(logMessage);
                await logToModChannel(interaction.client, logMessage);

                return interaction.editReply?.({ content: `✅ Auto-cleanup complete: ${removed} inactive validators removed.` });
            }

            cleanupState.set(interaction.user.id, {
                inactiveOnly: inactiveValidators,
                all: allInactive,
                interactionToken: interaction.token
            });

            const guild = await interaction.guild.fetch?.() || interaction.guild;
            const memberInfo = await Promise.all(
                allInactive.map(v =>
                    guild.members.fetch(v.discord_id)
                        .then(m => ({ tag: m.user.tag, id: m.id }))
                        .catch(() => ({ tag: 'Unknown user', id: v.discord_id }))
                )
            );

            const inactiveList = allInactive
                .map((v, i) => `- ${memberInfo[i].tag} ${v.wallet_address}`)
                .join('\n');

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('confirm_validator_cleanup')
                    .setLabel('Remove only inactive')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('confirm_validator_cleanup_all')
                    .setLabel('Remove ALL (including suspended)')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('cancel_validator_cleanup')
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Secondary)
            );

            await interaction.editReply?.({
                content: `Found ${allInactive.length} inactive validators:\n${inactiveList}\n\nChoose cleanup option:`,
                components: [row]
            });

            setTimeout(() => {
                cleanupState.delete(interaction.user.id);
            }, 120000);
        });
    } catch (error) {
        console.error('Validator cleanup error:', error);
        await interaction.editReply?.({ content: 'An error occurred during validator cleanup' });
    }
}

async function handleCleanupConfirmation(interaction) {
    if (!interaction.isButton()) return;

    const state = cleanupState.get(interaction.user.id);
    if (!state) return;

    try {
        await interaction.deferUpdate();

        const guild = await interaction.guild.fetch();
        const role = await guild.roles.fetch(VALIDATOR_ROLE_ID);
        let targets = [];

        if (interaction.customId === 'confirm_validator_cleanup') {
            targets = state.inactiveOnly;
        } else if (interaction.customId === 'confirm_validator_cleanup_all') {
            targets = state.all;
        } else if (interaction.customId === 'cancel_validator_cleanup') {
            await interaction.editReply({
                content: 'Cleanup cancelled',
                components: []
            });
            return;
        }

        let removed = 0;
        const logLines = [];

        for (const v of targets) {
            const userTag = await guild.members.fetch(v.discord_id)
                .then(m => {
                    m.roles.remove(role);
                    return m.user.tag;
                })
                .catch(() => 'Unknown user');

            await pool.query(
                `DELETE FROM verifications 
                 WHERE wallet_address = $1 
                 AND role_type = 'Validator'`,
                [v.wallet_address]
            );

            logLines.push(`• ${userTag} — \`${v.wallet_address}\``);
            removed++;
        }

        const logMessage = `🧹 **Manual cleanup completed**
Removed ${removed} validators (${interaction.customId === 'confirm_validator_cleanup_all' ? 'all (incl. suspended)' : 'inactive only'}):
` + logLines.join('\n');

        console.log(logMessage);
        await logToModChannel(interaction.client, logMessage);

        await interaction.editReply({
            content: `✅ Removed ${removed} validators successfully.`,
            components: []
        });
    } catch (error) {
        console.error('Cleanup execution error:', error);
        await interaction.editReply({
            content: 'Failed to complete cleanup',
            components: []
        });
    } finally {
        cleanupState.delete(interaction.user.id);
    }
}

function startScheduledValidatorCleanup(client) {
    cron.schedule("5 9 * * *", async () => {
        console.log("⏰ Running scheduled validator cleanup (09:05 UTC)");

        try {
            const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
            const botMember = await guild.members.fetch(client.user.id);

            const fakeInteraction = {
                member: botMember,
                guild,
                deferReply: async () => {},
                editReply: async (data) =>
                    console.log(`[AUTO-VALIDATOR-CLEANUP] ${data?.content || '[No content]'}`),
                reply: async (data) =>
                    console.log(`[AUTO-CLEANUP-REPLY] ${data?.content || '[No content]'}`),
                user: client.user,
                client: client
            };

            await handleCleanupValidators(fakeInteraction, { autoConfirm: true });
        } catch (error) {
            console.error("❌ Scheduled validator cleanup failed:", error);
        }
    }, {
        timezone: "UTC"
    });
}

module.exports = {
    handleCleanupValidators,
    handleCleanupConfirmation,
    startScheduledValidatorCleanup
};