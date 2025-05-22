// validators-cleanup.js
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');
const { exec } = require('child_process');
const { Pool } = require('pg');

const CLIENT_PATH = process.env.CONCORDIUM_CLIENT_PATH;
const VALIDATOR_ROLE_ID = process.env.VALIDATOR_ROLE_ID;
const GRPC_IP = process.env.GRPC_IP;

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT
});

// Temporary storage for confirmations
const cleanupState = new Map();

async function handleCleanupValidators(interaction) {
    // Checking administrator rights
    if (!interaction.member.permissions.has('Administrator')) {
        return interaction.reply({
            content: 'This command requires administrator permissions',
            flags: MessageFlags.Ephemeral
        });
    }

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const cmd = `${CLIENT_PATH} consensus show-parameters --include-bakers --grpc-ip ${GRPC_IP} --secure | awk 'NR>4 && NF {print $2}'`;

        exec(cmd, async (err, stdout, stderr) => {
            if (err) {
                console.error('Validator check failed:', stderr);
                return interaction.editReply('Failed to fetch validators from blockchain');
            }

            const activeValidators = new Set(
                stdout.trim()
                    .split('\n')
                    .filter(addr => addr.length > 0)
            );

            const dbResult = await pool.query(
                "SELECT discord_id, wallet_address FROM verifications WHERE role_type = 'Validator'"
            );

            const inactiveValidators = dbResult.rows.filter(
                row => !activeValidators.has(row.wallet_address)
            );

            if (inactiveValidators.length === 0) {
                return interaction.editReply('All registered validators are currently active');
            }

            const guild = await interaction.guild.fetch();
            const memberInfo = await Promise.all(
                inactiveValidators.map(v =>
                    guild.members.fetch(v.discord_id)
                        .then(m => ({
                            tag: m.user.tag,
                            id: m.id
                        }))
                        .catch(() => ({
                            tag: 'Unknown user',
                            id: v.discord_id
                        }))
                )
            );

            const inactiveList = inactiveValidators
                .map((v, i) => `- ${memberInfo[i].tag} (${v.wallet_address})`)
                .join('\n');

            cleanupState.set(interaction.user.id, {
                discordIds: inactiveValidators.map(v => v.discord_id),
                walletAddresses: inactiveValidators.map(v => v.wallet_address),
                interactionToken: interaction.token
            });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('confirm_validator_cleanup')
                    .setLabel('Confirm Removal')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('cancel_validator_cleanup')
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Secondary)
            );

            await interaction.editReply({
                content: `Found ${inactiveValidators.length} inactive validators:\n${inactiveList}\n\nConfirm removal?`,
                components: [row]
            });

            setTimeout(() => {
                cleanupState.delete(interaction.user.id);
            }, 120000);
        });
    } catch (error) {
        console.error('Validator cleanup error:', error);
        await interaction.editReply('An error occurred during validator cleanup');
    }
}

async function handleCleanupConfirmation(interaction) {
    if (!interaction.isButton()) return;

    const state = cleanupState.get(interaction.user.id);
    if (!state) return;

    try {
        await interaction.deferUpdate();

        if (interaction.customId === 'confirm_validator_cleanup') {
            const { discordIds, walletAddresses } = state;
            const guild = await interaction.guild.fetch();
            const role = await guild.roles.fetch(VALIDATOR_ROLE_ID);

            await Promise.all(discordIds.map(id =>
                guild.members.fetch(id)
                    .then(member => member.roles.remove(role))
                    .catch(() => null)
            ));

            await pool.query(
                `DELETE FROM verifications 
                 WHERE wallet_address = ANY($1::text[]) 
                 AND role_type = 'Validator'`,
                [walletAddresses]
            );

            await interaction.editReply({
                content: `Successfully removed ${discordIds.length} inactive validators`,
                components: []
            });
        } else {
            await interaction.editReply({
                content: 'Cleanup cancelled',
                components: []
            });
        }
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

module.exports = {
    handleCleanupValidators,
    handleCleanupConfirmation
};