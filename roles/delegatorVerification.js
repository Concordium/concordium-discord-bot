const { ChannelType, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { exec } = require("child_process");
const { Pool } = require("pg");

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CLAIM_CHANNEL_ID = process.env.CLAIM_CHANNEL_ID;
const DELEGATOR_ROLE_ID = process.env.DELEGATOR_ROLE_ID;
const CLIENT_PATH = process.env.CONCORDIUM_CLIENT_PATH;
const GRPC_IP = process.env.GRPC_IP;

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT
});

const delegatorVerificationState = new Map();
const INACTIVE_THREAD_CHECK_INTERVAL = 3600000; // Check for inactive threads every 1 hour
const THREAD_INACTIVITY_LIMIT = 86400000; // Delete threads inactive for 24 hours

/**
 * Generates a random numeric MEMO of length between 5 and 10 digits
 * @returns {string} Random numeric string
 */
function generateRandomMemo() {
    const length = Math.floor(Math.random() * 6) + 5; // Random length between 5 and 10
    let result = '';
    for (let i = 0; i < length; i++) {
        result += Math.floor(Math.random() * 10); // Random digit 0-9
    }
    return result;
}

/**
 * Cleans up inactive verification threads that have been inactive for more than 24 hours
 * @param {Client} client Discord client instance
 */
async function cleanupInactiveThreads(client) {
    try {
        const now = Date.now();
        const verificationChannel = await client.channels.fetch(CLAIM_CHANNEL_ID).catch(() => null);
        if (!verificationChannel) return;

        const threads = await verificationChannel.threads.fetchActive();
        
        for (const [, thread] of threads.threads) {
            // Skip non-delegator threads or non-private threads
            if (thread.type !== ChannelType.PrivateThread || !thread.name.startsWith('delegator-')) continue;

            // Get the last couple messages to check user activity
            const messages = await thread.messages.fetch({ limit: 2 });
            if (messages.size < 2) continue; // Skip if only bot messages

            const lastUserMessage = messages.find(m => !m.author.bot);
            if (!lastUserMessage) continue;

            // Delete thread if inactive for more than 24 hours
            if (now - lastUserMessage.createdTimestamp > THREAD_INACTIVITY_LIMIT) {
                try {
                    await thread.delete('Automatic deletion after 24 hours of inactivity');
                    const userId = thread.name.split('-')[2]; // Extract user ID from thread name
                    delegatorVerificationState.delete(userId);
                } catch (err) {
                    console.error(`Error deleting inactive thread ${thread.id}:`, err);
                }
            }
        }
    } catch (err) {
        console.error('Error in inactive threads cleanup:', err);
    }
}

/**
 * Starts the periodic cleanup of inactive threads
 * @param {Client} client Discord client instance
 */
function startInactiveThreadsCleanup(client) {
    setInterval(() => cleanupInactiveThreads(client), INACTIVE_THREAD_CHECK_INTERVAL);
}

/**
 * Handles the delegator verification process initiation
 * @param {Interaction} interaction Discord interaction
 * @param {string} discordId User's Discord ID
 * @param {Client} client Discord client
 */
async function handleDelegatorVerification(interaction, discordId, client) {
    try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(discordId);

        // Check if user already has the role
        if (member.roles.cache.has(DELEGATOR_ROLE_ID)) {
            await interaction.reply({
                content: "✅ You already have the **Delegator** role — no need to verify again.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // Check for existing verification thread
        if (delegatorVerificationState.has(discordId)) {
            const existing = delegatorVerificationState.get(discordId);
            const existingThread = await client.channels.fetch(existing.threadId).catch(() => null);

            if (existingThread) {
                await interaction.reply({
                    content: `⚠️ You already have an active verification thread.\n👉 [Open thread](https://discord.com/channels/${GUILD_ID}/${existingThread.id})`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            } else {
                delegatorVerificationState.delete(discordId);
            }
        }

        // Start cleanup if not already running
        if (!delegatorVerificationState.cleanupStarted) {
            startInactiveThreadsCleanup(client);
            delegatorVerificationState.cleanupStarted = true;
        }

        // Create private thread for verification
        const verificationChannel = await client.channels.fetch(CLAIM_CHANNEL_ID);
        const thread = await verificationChannel.threads.create({
            name: `delegator-${interaction.user.username}-${interaction.user.id}`,
            type: ChannelType.PrivateThread,
            autoArchiveDuration: 60,
            reason: `Delegator verification for ${interaction.user.tag}`
        });

        await thread.members.add(interaction.user.id);

        // Store verification state
        delegatorVerificationState.set(discordId, {
            threadId: thread.id,
            step: "awaiting-account-address",
            createdAt: Math.floor(Date.now() / 1000),
            lastActivity: Date.now()
        });

        await interaction.reply({
            content: `📩 Verification started.\n👉 [Click here to open your thread](https://discord.com/channels/${GUILD_ID}/${thread.id})`,
            flags: MessageFlags.Ephemeral
        });

        // Send initial instructions
        await thread.send(
            `<@${interaction.user.id}> Please send your **account address** to begin verification.\n\n` +
            `**Requirements:**\n` +
            `- You must be delegating at least **1000 CCD**\n` +
            `- You have 1 hour to complete each verification step\n` +
            `- Inactive threads will be deleted after 24 hours\n\n` +
            `If you entered the wrong address, use \`/start-again-delegator\` to restart.`
        );
    } catch (err) {
        console.error("Delegator verification thread error:", err);
        await interaction.reply({
            content: "❌ Failed to start delegator verification. Please contact a moderator.",
            flags: MessageFlags.Ephemeral
        });
    }
}

/**
 * Listens for delegator verification messages and handles the verification flow
 * @param {Client} client Discord client
 */
function listenForDelegatorMessages(client) {
    client.on("messageCreate", async (message) => {
        if (!message.channel.isThread()) return;
        if (message.author.bot) return;

        const state = delegatorVerificationState.get(message.author.id);
        if (!state || state.threadId !== message.channel.id) return;

        // Update last activity timestamp
        state.lastActivity = Date.now();
        delegatorVerificationState.set(message.author.id, state);

        // Check session timeout (1 hour per step)
        const currentTimestamp = Math.floor(Date.now() / 1000);
        if (currentTimestamp - (state.createdAt || currentTimestamp) > 3600) {
            delegatorVerificationState.delete(message.author.id);
            await message.reply("❌ Your verification session has expired (1 hour limit). Please start a new verification process.");
            return;
        }

        // Step 1: Waiting for account address
        if (state.step === "awaiting-account-address") {
            const address = message.content.trim();

            // Validate Concordium address format
            if (!/^[1-9A-HJ-NP-Za-km-z]{50,60}$/.test(address)) {
                return message.reply("❌ Please enter a valid Concordium account address.");
            }

            // Check if address is already registered
            const exists = await pool.query(
                "SELECT * FROM verifications WHERE wallet_address = $1 AND role_type = 'Delegator'", 
                [address]
            );
            if (exists.rowCount > 0) {
                return message.reply("❌ This address is already registered as a Delegator. Please check the address or contact a moderator.");
            }

            // Verify delegation status using Concordium client
            const cmd = `${CLIENT_PATH} account show ${address} --grpc-ip ${GRPC_IP} --secure`;
            exec(cmd, async (err, stdout) => {
                if (err || !stdout.includes("Delegation target:")) {
                    return message.reply("❌ This address is not currently delegating to any staking pool.");
                }

                // Check staked amount (minimum 1000 CCD)
                const stakeMatch = stdout.match(/Staked amount: ([\d.]+) CCD/);
                const stakedAmount = stakeMatch ? parseFloat(stakeMatch[1]) : 0;

                if (stakedAmount < 1000) {
                    return message.reply(
                        `❌ Your staked amount is **${stakedAmount} CCD**, which is below the required **1000 CCD**.\n` +
                        `Please increase your delegation and try again.`
                    );
                }

                // Generate random MEMO for transaction verification
                const randomMemo = generateRandomMemo();

                // Move to next step
                delegatorVerificationState.set(message.author.id, {
                    ...state,
                    step: "awaiting-tx-hash",
                    delegatorAddress: address,
                    randomMemo,
                    lastActivity: Date.now()
                });

                await message.reply(
                    `✅ Account verified! Now send a CCD transaction **from this address** with these requirements:\n\n` +
                    `**1.** Send to any address (amount doesn't matter)\n` +
                    `**2.** Use this exact number as MEMO: \`${randomMemo}\`\n` +
                    `**3.** Transaction must be sent within 1 hour\n\n` +
                    `After sending, reply here with the **transaction hash**.`
                );
            });
        }

        // Step 2: Waiting for transaction hash
        if (state.step === "awaiting-tx-hash") {
            const txHash = message.content.trim().toLowerCase();
            
            // Validate transaction hash format
            if (!/^[0-9a-f]{64}$/.test(txHash)) {
                return message.reply("❌ Please enter a valid 64-character transaction hash.");
            }

            // Check transaction status using Concordium client
            const cmd = `${CLIENT_PATH} transaction status ${txHash} --grpc-ip ${GRPC_IP} --secure`;
            exec(cmd, async (err, stdout) => {
                if (err || !stdout.includes("Transaction is finalized") || !stdout.includes('with status "success"')) {
                    return message.reply("❌ Transaction is not finalized or was not successful.");
                }

                const { delegatorAddress, randomMemo } = state;

                // Extract transaction details
                const senderMatch = stdout.match(/from account '([^']+)'/);
                const memoMatch = stdout.match(/Transfer memo:\n(.+)/);
                const blockHashMatch = stdout.match(/Transaction is finalized into block ([0-9a-fA-F]{64})/);

                const sender = senderMatch?.[1];
                const memo = memoMatch?.[1]?.trim();
                const blockHash = blockHashMatch?.[1];

                // Validate sender address
                if (!sender || sender !== delegatorAddress) {
                    return message.reply(`❌ Sender address must match your delegator address: \`${delegatorAddress}\``);
                }

                // Validate MEMO matches our generated number
                if (!memo || memo !== randomMemo) {
                    return message.reply(`❌ The MEMO must exactly match the generated number: \`${randomMemo}\``);
                }

                if (!blockHash) {
                    return message.reply("❌ Unable to extract block hash to validate transaction time.");
                }

                // Check transaction timestamp (must be within 1 hour)
                const getTimestampCmd = `${CLIENT_PATH} block show ${blockHash} --grpc-ip ${GRPC_IP} --secure | awk -F': +' '/Block time/ {print $2}'`;
                exec(getTimestampCmd, async (timeErr, timeStdout) => {
                    if (timeErr || !timeStdout.trim()) {
                        return message.reply("❌ Failed to retrieve block timestamp.");
                    }

                    const txTimestamp = Date.parse(timeStdout.trim()) / 1000;
                    const currentTimestamp = Math.floor(Date.now() / 1000);

                    if (currentTimestamp - txTimestamp > 3600) {
                        return message.reply("❌ This transaction is older than 1 hour. Please submit a fresh one.");
                    }

                    // Check if transaction was already used
                    const txExists = await pool.query("SELECT * FROM verifications WHERE tx_hash = $1", [txHash]);
                    if (txExists.rowCount > 0) {
                        return message.reply("❌ This transaction has already been used for verification.");
                    }

                    // Store verification in database
                    await pool.query(
                        "INSERT INTO verifications (tx_hash, wallet_address, discord_id, role_type) VALUES ($1, $2, $3, $4)",
                        [txHash, delegatorAddress, message.author.id, "Delegator"]
                    );

                    // Assign delegator role
                    const guild = await client.guilds.fetch(GUILD_ID);
                    const member = await guild.members.fetch(message.author.id);
                    await member.roles.add(DELEGATOR_ROLE_ID);
                    console.log(`Role 'delegator' assigned to user ${message.author.id}`);

                    // Add thread deletion button
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId("archive_thread_delegator")
                            .setLabel("🗑️ Delete this thread")
                            .setStyle(ButtonStyle.Secondary)
                    );

                    await message.reply({
                        content: "🎉 You have been successfully verified as a **Delegator** and your role has been assigned! You can now delete this thread.",
                        components: [row]
                    });

                    // Clean up verification state
                    delegatorVerificationState.delete(message.author.id);
                });
            });
        }
    });

    // Handle thread deletion button
    client.on("interactionCreate", async (interaction) => {
        if (!interaction.isButton()) return;

        if (interaction.customId === "archive_thread_delegator") {
            try {
                await interaction.channel.delete("Thread deleted after successful delegator verification.");
            } catch (err) {
                console.error("Thread archiving failed:", err);
                await interaction.reply({
                    content: "❌ Failed to archive thread. Please try again later.",
                    flags: MessageFlags.Ephemeral
                });
            }
        }
    });
}

/**
 * Restarts the delegator verification flow
 * @param {Interaction} interaction Discord interaction
 * @param {Client} client Discord client
 */
module.exports = {
    handleDelegatorVerification,
    listenForDelegatorMessages,
    restartDelegatorFlow: async function (interaction, client) {
        const discordId = interaction.user.id;

        const existingState = delegatorVerificationState.get(discordId);
        if (!existingState) {
            return interaction.reply({
                content: "⚠️ You don't have an active verification thread. Please start the verification using the dropdown menu.",
                flags: MessageFlags.Ephemeral
            });
        }

        const thread = await client.channels.fetch(existingState.threadId).catch(() => null);
        if (!thread) {
            delegatorVerificationState.delete(discordId);
            return interaction.reply({
                content: "⚠️ Your previous verification thread could not be found. Please start again from the dropdown menu.",
                flags: MessageFlags.Ephemeral
            });
        }

        // Reset verification state
        delegatorVerificationState.set(discordId, {
            threadId: thread.id,
            step: "awaiting-account-address",
            createdAt: Math.floor(Date.now() / 1000),
            lastActivity: Date.now()
        });

        await thread.send(
            `<@${interaction.user.id}> 🔁 Verification has been restarted.\n\n` +
            `Please send your **account address** again.\n` +
            `**Remember:**\n` +
            `- You must be delegating at least **1000 CCD**\n` +
            `- You have 1 hour to complete each step\n` +
            `- Inactive threads will be deleted after 24 hours\n\n` +
            `If you entered the wrong address again, use \`/start-again-delegator\` to restart.`
        );

        await interaction.reply({
            content: "🔄 Verification process restarted in your existing thread.",
            flags: MessageFlags.Ephemeral
        });
    }
};