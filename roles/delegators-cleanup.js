// delegators-cleanup.js
const {
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const { exec } = require('child_process');
const { Pool } = require('pg');

const CLIENT_PATH = process.env.CONCORDIUM_CLIENT_PATH;
const DELEGATOR_ROLE_ID = process.env.DELEGATOR_ROLE_ID;

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT
});

const cleanupState = new Map();

async function handleCleanupDelegators(interaction) {
    if (!interaction.member.permissions.has('Administrator')) {
        return interaction.reply({
            content: 'This command requires administrator permissions',
            flags: MessageFlags.Ephemeral
        });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const dbResult = await pool.query(
            "SELECT discord_id, wallet_address FROM verifications WHERE role_type = 'Delegator'"
        );

        const guild = await interaction.guild.fetch();
        const inactive = [];

        for (const row of dbResult.rows) {
            const { discord_id, wallet_address } = row;

            const cmd = `${CLIENT_PATH} account show ${wallet_address} --grpc-ip grpc.mainnet.concordium.software --secure`;

            const isInactive = await new Promise((resolve) => {
                exec(cmd, (err, stdout, stderr) => {
                    if (err || !stdout) return resolve(false);
                    const output = stdout.trim();
                    if (output.includes('Delegation target: Staking pool with ID')) return resolve(false);
                    if (output.includes('Validator or delegator: no')) return resolve(true);
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
            return interaction.editReply('✅ All delegators are currently active.');
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
        await interaction.editReply({
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

module.exports = {
    handleCleanupDelegators,
    handleCleanupDelegatorConfirmation
};