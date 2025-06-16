const { ChannelType, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { exec } = require("child_process");
const { Pool } = require("pg");

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CLAIM_CHANNEL_ID = process.env.CLAIM_CHANNEL_ID;
const VALIDATOR_ROLE_ID = process.env.VALIDATOR_ROLE_ID;
const CLIENT_PATH = process.env.CONCORDIUM_CLIENT_PATH;
const GRPC_IP = process.env.GRPC_IP;

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT
});

const validatorVerificationState = new Map();
const INACTIVE_THREAD_CHECK_INTERVAL = 60000; // 1 minute
const THREAD_INACTIVITY_LIMIT = 3600000; // 1 hour

function generateRandomMemo() {
    const length = Math.floor(Math.random() * 6) + 5; // Random length between 5 and 10
    let result = '';
    for (let i = 0; i < length; i++) {
        result += Math.floor(Math.random() * 10); // Random digit 0-9
    }
    return result;
}

async function cleanupInactiveThreads(client) {
    try {
        const now = Date.now();
        const verificationChannel = await client.channels.fetch(CLAIM_CHANNEL_ID).catch(() => null);
        if (!verificationChannel) return;

        const threads = await verificationChannel.threads.fetchActive();
        
        for (const [, thread] of threads.threads) {
            if (thread.type !== ChannelType.PrivateThread || !thread.name.startsWith('validator-')) continue;

            const messages = await thread.messages.fetch({ limit: 100 });
            const lastUserMessage = messages.find(m => !m.author.bot);

            let lastActivityTimestamp;
            if (lastUserMessage) {
                lastActivityTimestamp = lastUserMessage.createdTimestamp;
            } else {
                lastActivityTimestamp = thread.createdTimestamp;
            }

            if (now - lastActivityTimestamp > THREAD_INACTIVITY_LIMIT) {
                try {
                    await thread.delete('Automatic deletion after inactivity');
                    const userId = thread.name.split('-')[2];
                    validatorVerificationState.delete(userId);
                } catch (err) {
                    console.error(`Error deleting inactive thread ${thread.id}:`, err);
                }
            }
        }
    } catch (err) {
        console.error('Error in inactive threads cleanup:', err);
    }
}

function startInactiveThreadsCleanup(client) {
    setInterval(() => cleanupInactiveThreads(client), INACTIVE_THREAD_CHECK_INTERVAL);
}

async function handleValidatorVerification(interaction, discordId, client) {
    // Clean up all validatorVerificationState records with missing threads (threads were deleted manually or expired)
    for (const [userId, state] of validatorVerificationState.entries()) {
        if (state.threadId) {
            const exists = await client.channels.fetch(state.threadId).catch(() => null);
            if (!exists) {
                validatorVerificationState.delete(userId);
                console.log('Removed validatorVerificationState for', userId, 'because thread does not exist');
            }
        }
    }

    try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(discordId);

        if (member.roles.cache.has(VALIDATOR_ROLE_ID)) {
            await interaction.reply({
                content: "✅ You already have the **Validator** role — no need to verify again.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (validatorVerificationState.has(discordId)) {
            const existing = validatorVerificationState.get(discordId);
            const existingThread = await client.channels.fetch(existing.threadId).catch(() => null);

            if (existingThread) {
                await interaction.reply({
                    content: `⚠️ You already have an active verification thread.\n👉 [Open thread](https://discord.com/channels/${GUILD_ID}/${existingThread.id})`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            } else {
                validatorVerificationState.delete(discordId);
            }
        }

        if (!validatorVerificationState.cleanupStarted) {
            startInactiveThreadsCleanup(client);
            validatorVerificationState.cleanupStarted = true;
        }

        const verificationChannel = await client.channels.fetch(CLAIM_CHANNEL_ID);
        const thread = await verificationChannel.threads.create({
            name: `validator-${interaction.user.username}-${interaction.user.id}`,
            type: ChannelType.PrivateThread,
            autoArchiveDuration: 60,
            reason: `Validator verification for ${interaction.user.tag}`,
            invitable: false
        });

        await thread.members.add(interaction.user.id);

        validatorVerificationState.set(discordId, {
            threadId: thread.id,
            step: "awaiting-validator-id",
            createdAt: Math.floor(Date.now() / 1000),
            lastActivity: Date.now()
        });

        await interaction.reply({
            content: `📩 The validator verification process has started.\n👉 [Click here to open your thread](https://discord.com/channels/${GUILD_ID}/${thread.id})`,
            flags: MessageFlags.Ephemeral
        });

        await thread.send(
            `<@${interaction.user.id}> Please send your **validator ID** to begin verification (e.g. 12345).\n\n` +
            `**Important notes:**\n` +
            `- If you leave this thread inactive for 1 hour, it will be automatically deleted\n` +
            `- If you entered the wrong ID, you can use the command \`/start-again-validator\` to restart`
        );
    } catch (err) {
        console.error("Validator verification thread error:", err);
        await interaction.reply({
            content: "❌ Failed to start validator verification. Please contact a moderator.",
            flags: MessageFlags.Ephemeral
        });
    }
}

function listenForValidatorMessages(client) {
    client.on("messageCreate", async (message) => {
        if (!message.channel.isThread()) return;
        if (message.author.bot) return;

        const state = validatorVerificationState.get(message.author.id);
		if (!state) {
			// Additional: Check if channel is a verification thread (optional, for more accuracy)
			if (message.channel.name.startsWith('validator-')) {
				await message.reply(
					"⚠️ The verification process for this thread is no longer active due to bot restarting. " +
					"Please start the verification process again in the <#1350064379936116829> channel"
				);
			}
			return;
		}
		if (state.threadId !== message.channel.id) return;

        // Update last activity timestamp
        state.lastActivity = Date.now();
        validatorVerificationState.set(message.author.id, state);

        if (state.step === "awaiting-validator-id") {
            const validatorId = message.content.trim();
            if (!/^\d+$/.test(validatorId)) {
                return message.reply("❌ Please enter a valid numeric validator ID.");
            }

            const cmd = `${CLIENT_PATH} consensus show-parameters --include-bakers --grpc-ip ${GRPC_IP} --secure | awk '$1 ~ /^${validatorId}:$/ {print $2}'`;

            exec(cmd, async (err, stdout, stderr) => {
                const errorText = (err?.message || "") + (stderr || "") + (stdout || "");
                // check for connection error with GRPC node
                if (
                    errorText.includes("Cannot establish connection to GRPC endpoint") ||
                    errorText.includes("I/O error") ||
                    errorText.includes("failed to connect") ||
                    errorText.includes("ECONNREFUSED") ||
                    errorText.includes("connection timed out") ||
                    errorText.includes("unavailable")
                ) {
                    return message.reply(
                        "⚠️ The verification service is temporarily unavailable (connection to Concordium node failed).\n" +
                        "Please try again later."
                    );
                }

                // If the command was successfully executed, but there is no output, then the ID was not found
                if (!stdout.trim()) {
                    return message.reply("❌ Failed to retrieve validator address. Please double-check the ID.");
                }

                // If another error occurred, we display a standard message
                if (err) {
                    return message.reply("❌ An unexpected error occurred while checking your validator ID. Please try again or contact support.");
                }

                const validatorAddress = stdout.trim();

                // Clean up all validatorVerificationState records with missing threads (threads were deleted manually or expired)
                for (const [userId, session] of validatorVerificationState.entries()) {
                    if (session.threadId) {
                        const exists = await message.client.channels.fetch(session.threadId).catch(() => null);
                        if (!exists) {
                            validatorVerificationState.delete(userId);
                            console.log('Removed validatorVerificationState for', userId, 'because thread does not exist');
                        }
                    }
                }

                // Prevent parallel verification of the same validator address
                // Only sessions where validatorAddress is already set and thread exists block verification
                const isInActiveSession = Array.from(validatorVerificationState.values()).some(
                    session =>
                        !!session.validatorAddress &&
                        session.validatorAddress === validatorAddress &&
                        session.threadId !== message.channel.id
                );
                if (isInActiveSession) {
                    return message.reply("❌ This validator is already being verified by another user.");
                }

                const exists = await pool.query("SELECT * FROM verifications WHERE wallet_address = $1 AND role_type = 'Validator'", [validatorAddress]);
                if (exists.rowCount > 0) {
                    return message.reply("❌ This validator address is already registered. Please check the ID or contact a moderator.");
                }

                const randomMemo = generateRandomMemo();

                validatorVerificationState.set(message.author.id, {
                    ...state,
                    step: "awaiting-tx-hash",
                    validatorId,
                    validatorAddress,
                    randomMemo,
                    lastActivity: Date.now()
                });

                await message.reply(
                    `✅ Your validator address is: \`${validatorAddress}\`\n\n` +
                    `Now send a CCD transaction **from this address to any address**, using this generated number as the MEMO: \`${randomMemo}\`\n\n` +
                    `**Transaction requirements:**\n` +
                    `- Any CCD amount (e.g. 0.000001)\n` +
					`- Must be sent within 1 hour\n` +
                    `- MEMO must exactly match: \`${randomMemo}\`\n` +
                    `- Reply here with the transaction hash when done`
                );
            });
        }

        if (state.step === "awaiting-tx-hash") {
            const txHash = message.content.trim().toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(txHash)) {
                return message.reply("❌ Please enter a valid 64-character transaction hash.");
            }

            const cmd = `${CLIENT_PATH} transaction status ${txHash} --grpc-ip ${GRPC_IP} --secure`;
            exec(cmd, async (err, stdout, stderr) => {
                const errorText = (err?.message || "") + (stderr || "") + (stdout || "");
                // GRPC error checking
                if (
                    errorText.includes("Cannot establish connection to GRPC endpoint") ||
                    errorText.includes("I/O error") ||
                    errorText.includes("failed to connect") ||
                    errorText.includes("ECONNREFUSED") ||
                    errorText.includes("connection timed out") ||
                    errorText.includes("unavailable")
                ) {
                    return message.reply(
                        "⚠️ The verification service is temporarily unavailable (connection to Concordium node failed).\n" +
                        "Please try again later."
                    );
                }

                if (err || !stdout.includes("Transaction is finalized") || !stdout.includes('with status "success"')) {
                    return message.reply("❌ Transaction is not finalized or was not successful.");
                }

                const { validatorId, validatorAddress, randomMemo } = state;

                const senderMatch = stdout.match(/from account '([^']+)'/);
                const memoMatch = stdout.match(/Transfer memo:\n(.+)/);
                const blockHashMatch = stdout.match(/Transaction is finalized into block ([0-9a-fA-F]{64})/);

                const sender = senderMatch?.[1];
                const memo = memoMatch?.[1];
                const blockHash = blockHashMatch?.[1];

                if (!sender || sender !== validatorAddress) {
                    return message.reply(`❌ Sender address must match the validator address: \`${validatorAddress}\``);
                }

                if (!memo || memo !== randomMemo) {
                    return message.reply(`❌ The MEMO must exactly match the generated number: \`${randomMemo}\``);
                }

                if (!blockHash) {
                    return message.reply("❌ Unable to extract block hash to validate transaction time.");
                }

                const getTimestampCmd = `${CLIENT_PATH} block show ${blockHash} --grpc-ip ${GRPC_IP} --secure | awk -F': +' '/Block time/ {print $2}'`;

                exec(getTimestampCmd, async (timeErr, timeStdout, timeStderr) => {
                    const timeErrorText = (timeErr?.message || "") + (timeStderr || "") + (timeStdout || "");
                    if (
                        timeErrorText.includes("Cannot establish connection to GRPC endpoint") ||
                        timeErrorText.includes("I/O error") ||
                        timeErrorText.includes("failed to connect") ||
                        timeErrorText.includes("ECONNREFUSED") ||
                        timeErrorText.includes("connection timed out") ||
                        timeErrorText.includes("unavailable")
                    ) {
                        return message.reply(
                            "⚠️ The verification service is temporarily unavailable (connection to Concordium node failed).\n" +
                            "Please try again later."
                        );
                    }

                    if (timeErr || !timeStdout.trim()) {
                        return message.reply("❌ Failed to retrieve block timestamp.");
                    }

                    const txTimestamp = Date.parse(timeStdout.trim()) / 1000;
                    const currentTimestamp = Math.floor(Date.now() / 1000);

                    if (currentTimestamp - txTimestamp > 3600) {
                        return message.reply("❌ This transaction is older than 1 hour. Please submit a fresh one.");
                    }

                    const txExists = await pool.query("SELECT * FROM verifications WHERE tx_hash = $1", [txHash]);
                    if (txExists.rowCount > 0) {
                        return message.reply("❌ This transaction has already been used.");
                    }

                    await pool.query(
                        "INSERT INTO verifications (tx_hash, wallet_address, discord_id, role_type) VALUES ($1, $2, $3, $4)",
                        [txHash, validatorAddress, message.author.id, "Validator"]
                    );

                    const guild = await client.guilds.fetch(GUILD_ID);
                    const member = await guild.members.fetch(message.author.id);
                    await member.roles.add(VALIDATOR_ROLE_ID);
                    console.log(`Role 'validator' successfully assigned to user ${message.author.id}`);

                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId("archive_thread_validator")
                            .setLabel("🗑️ Delete this thread")
                            .setStyle(ButtonStyle.Secondary)
                    );

                    await message.reply({
                        content: "🎉 You have been successfully verified as a **Validator** and your role has been assigned! You now have access to the private validators channel: <https://discord.com/channels/667378330923696158/1374009219753316474>\n\nYou can now delete this thread.",
                        components: [row]
                    });

                    validatorVerificationState.delete(message.author.id);
                });
            });
        }
    });

    client.on("interactionCreate", async (interaction) => {
        if (!interaction.isButton()) return;

        if (interaction.customId === "archive_thread_validator") {
            try {
                await interaction.channel.delete("Thread deleted after successful validator verification.");
            } catch (err) {
                console.error("Thread archiving failed:", err);
                await interaction.reply({
                    content: "❌ Failed to archive thread. Please try again later.",
                    flags: MessageFlags.Ephemeral
                });
            }
        }
    });

    // Remove validator verification state if the thread/channel is deleted manually
    client.on("channelDelete", async (channel) => {
        if (
            channel.type === ChannelType.PrivateThread &&
            channel.name.startsWith('validator-')
        ) {
            for (const [discordId, state] of validatorVerificationState.entries()) {
                if (state.threadId === channel.id) {
                    validatorVerificationState.delete(discordId);
                    console.log('Removed validatorVerificationState for', discordId, 'due to channelDelete');
                    break;
                }
            }
        }
    });
}

module.exports = {
    handleValidatorVerification,
    listenForValidatorMessages,
    restartValidatorFlow: async function (interaction, client) {
        const discordId = interaction.user.id;

        const existingState = validatorVerificationState.get(discordId);
        if (!existingState) {
            return interaction.reply({
                content: "⚠️ You don't have an active verification thread. Please start the verification using the dropdown menu.",
                flags: MessageFlags.Ephemeral
            });
        }

        const thread = await client.channels.fetch(existingState.threadId).catch(() => null);
        if (!thread) {
            validatorVerificationState.delete(discordId);
            return interaction.reply({
                content: "⚠️ Your previous verification thread could not be found. Please start again from the dropdown menu.",
                flags: MessageFlags.Ephemeral
            });
        }

        validatorVerificationState.set(discordId, {
            threadId: thread.id,
            step: "awaiting-validator-id",
            createdAt: Math.floor(Date.now() / 1000),
            lastActivity: Date.now()
        });

        await thread.send(
            `<@${interaction.user.id}> 🔁 Verification has been restarted.\n` +
            `Please send your **validator ID** again (e.g. \`12345\`).\n\n` +
            `**Remember:**\n` +
            `- You have 1 hour to complete each step\n` +
            `- Inactive threads will be deleted after 1 hour\n` +
            `- Use \`/start-again-validator\` if you need to restart again`
        );

        await interaction.reply({
            content: "🔄 Verification process restarted in your existing thread.",
            flags: MessageFlags.Ephemeral
        });
    }
};
