// roles/validatorVerification.js
/**
 * Orchestrates the **Validator** verification flow for the Discord bot.
 * Responsibilities:
 * - Creates & manages private verification threads and a two-step flow:
 *   1) Collect validator ID → resolve on-chain validator address (via concordium-client).
 *   2) Generate a numeric MEMO and auto-detect the confirming transaction (via txlogger).
 * - Hooks txlogger notifiers to inform about wrong MEMO and expired waits; unregisters watchers safely.
 * - Persists results in Postgres (`verifications`, `validator_commissions`), prevents duplicate TX/hash/address,
 *   captures suspension status, and seeds initial commission rates.
 * - Assigns the Validator role on success, posts mod logs, and offers a “Delete this thread” button.
 * - Watches the chain (Concordium gRPC/web-sdk) for **BakerRemoved** to revoke roles, DM users, and purge DB rows.
 * - Guards state with inactivity cleanup, uniqueness checks, and ephemeral replies; supports “restart” of the flow.
 */
const {
  ChannelType,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { Pool } = require("pg");
const { MSGS } = require("../utils/messages");
const { isGrpcUnavailable } = require("../utils/grpcerrors");
const { generateRandomMemo } = require("../utils/randommemo");
const { startInactiveThreadsCleanup } = require("../utils/threadCleanup");
const { runCommandWithRetry } = require("../utils/retry");
const { refreshValidatorDelegators } = require("../modules/validatorDelegators");

let _txl = null;
async function _getTxl() {
  if (_txl) return _txl;
  const m = await import("../modules/txloggerListener.js");
  _txl = m.default || m;
  return _txl;
}

function setValidatorWrongMemoNotifier(fn) {
  _getTxl().then(m => m.setValidatorWrongMemoNotifier(fn)).catch(() => {});
}
function setValidatorWaiterExpiredNotifier(fn) {
  _getTxl().then(m => m.setValidatorWaiterExpiredNotifier(fn)).catch(() => {});
}
function registerValidatorMemoWaiter(args) {
  let unsubscribe = () => {};
  _getTxl().then(m => {
    try {
      const u = m.registerValidatorMemoWaiter(args);
      if (typeof u === "function") unsubscribe = u;
    } catch {}
  });
  return () => { try { unsubscribe(); } catch {} };
}

const CLIENT_PATH = process.env.CONCORDIUM_CLIENT_PATH;
const GRPC_IP = process.env.GRPC_IP;
const GRPC_PORT = process.env.GRPC_PORT;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CLAIM_CHANNEL_ID = process.env.CLAIM_CHANNEL_ID;
const VALIDATOR_ROLE_ID = process.env.VALIDATOR_ROLE_ID;
const VALIDATOR_CHANNEL_ID = process.env.VALIDATOR_CHANNEL_ID;
const MOD_LOGS_CHANNEL_ID = process.env.MOD_LOGS_CHANNEL_ID;

let ConcordiumGRPCNodeClient, credentials;
const USE_TLS =
  (process.env.GRPC_TLS || "").toLowerCase() === "true" ||
  process.env.GRPC_TLS === "1";
const GRPC_HOST = GRPC_IP || "127.0.0.1";
const GRPC_PORT_NUM = Number(GRPC_PORT || 20000);

const SECURE_FLAG = USE_TLS ? "--secure" : "";

const pool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT,
});

const validatorVerificationState = new Map();

let wrongMemoNotifierInitialized = false;
function ensureWrongMemoNotifier(client) {
  if (wrongMemoNotifierInitialized) return;
  setValidatorWrongMemoNotifier(async ({ threadId, expected }) => {
    try {
      const ch = await client.channels.fetch(threadId);
      await ch.send(MSGS.txWrongMemo(expected));
    } catch {
    }
  });
  wrongMemoNotifierInitialized = true;
}

let validatorExpiredNotifierInitialized = false;
function ensureValidatorExpiredNotifier(client) {
  if (validatorExpiredNotifierInitialized) return;
  setValidatorWaiterExpiredNotifier(async ({ threadId, minutes }) => {
    try {
      const ch = await client.channels.fetch(threadId);
      await ch.send(
        `⏲️ The verification timed out (no transaction with the expected memo within ${minutes} minutes).\n` +
          `Please use \`/start-again-validator\` to restart and get a new code.`
      );
    } catch {}
  });
  validatorExpiredNotifierInitialized = true;
}

let validatorRemovalWatcherStarted = false;

async function ensureValidatorRemovalWatcher(client) {
  if (validatorRemovalWatcherStarted) return;
  validatorRemovalWatcherStarted = true;

  if (!ConcordiumGRPCNodeClient) {
    ({ ConcordiumGRPCNodeClient, credentials } = await import("@concordium/web-sdk/nodejs"));
  }
  const creds = USE_TLS ? credentials.createSsl() : credentials.createInsecure();

  (async function loop() {
    let lastHeight = null;

    while (true) {
      try {
        const grpc = new ConcordiumGRPCNodeClient(GRPC_HOST, GRPC_PORT_NUM, creds);
        await grpc.getConsensusStatus();

        const stream =
          lastHeight == null
            ? grpc.getFinalizedBlocks()
            : grpc.getFinalizedBlocksFrom(BigInt(lastHeight + 1));

        for await (const b of stream) {
          const h =
            typeof b.height === "bigint"
              ? Number(b.height)
              : typeof b.blockHeight === "bigint"
              ? Number(b.blockHeight)
              : Number(b.height ?? b.blockHeight ?? 0);

          const hash = b.hash ?? b.blockHash;

          try {
            for await (const item of grpc.getBlockTransactionEvents(hash)) {
              const events =
                item?.events ?? item?.summary?.events ?? item?.result?.events ?? [];
              for (const ev of events) {
                const tag = ev?.tag || ev?.type || ev?._tag;
                if (tag !== "BakerRemoved") continue;

                const accRaw = ev?.account || ev?.address || ev?.owner;
                const validatorAddress =
                  typeof accRaw === "string"
                    ? accRaw
                    : (accRaw?.account ?? accRaw?.address ?? accRaw?.value ?? null);

                const bakerIdRaw = ev?.bakerId ?? ev?.bakerID ?? ev?.id ?? null;
                const validatorId = bakerIdRaw != null ? Number(String(bakerIdRaw)) : null;

                if (!validatorAddress && validatorId == null) continue;

                const rows = await pool.query(
                  `SELECT id, discord_id, wallet_address, validator_id
                     FROM verifications
                    WHERE role_type = 'Validator'
                      AND (
                        ($1::text IS NOT NULL AND wallet_address = $1)
                        OR ($2::int IS NOT NULL AND validator_id = $2)
                      )`,
                  [validatorAddress || null, validatorId]
                );

                if (rows.rowCount === 0) continue;

                for (const r of rows.rows) {
                  const discordId = r.discord_id;

                  try {
                    const guild = await client.guilds.fetch(GUILD_ID);
                    const member = await guild.members.fetch(discordId).catch(() => null);
                    if (member?.roles?.cache?.has?.(VALIDATOR_ROLE_ID)) {
                      await member.roles.remove(VALIDATOR_ROLE_ID);
                    }
                  } catch {}

                  try {
                    const user = await client.users.fetch(discordId).catch(() => null);
                    if (user) {
                      await user.send(
                        "⌛ We detected you **stopped validating** on-chain (your baker was removed).\n" +
                          "Your **Validator** role has been removed. If you resume validating, please verify again via the menu."
                      );
                    }
                  } catch {}

                  try {
                    const ch = await client.channels.fetch(MOD_LOGS_CHANNEL_ID).catch(() => null);
                    if (ch?.isTextBased?.()) {
                      await ch.send(
                        `🧹 Removed **Validator** role & DB record for <@${discordId}> ` +
                          `(address \`${validatorAddress || r.wallet_address}\`${validatorId != null ? `, id ${validatorId}` : ""}).`
                      );
                    }
                  } catch {}
                }

                try {
                  await pool.query(
                    `DELETE FROM verifications
                      WHERE role_type='Validator'
                        AND (
                          ($1::text IS NOT NULL AND wallet_address = $1)
                          OR ($2::int IS NOT NULL AND validator_id = $2)
                        )`,
                    [validatorAddress || null, validatorId]
                  );
                } catch {}
              }
            }
          } catch {
          }

          lastHeight = h;
        }

        await new Promise((r) => setTimeout(r, 1000));
      } catch (e) {
        console.error(`[validator-watch] error: ${e?.message || e}. Reconnecting in 1s...`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  })();
}

async function finalizeValidatorVerificationViaTxLogger({
  client,
  discordId,
  threadId,
  validatorId,
  validatorAddress,
  txHash,
  blockHash,
  timestampIso,
}) {
  try {
    const st = validatorVerificationState.get(discordId);
    st?.unregisterWaiter?.();
    if (st) {
      st.unregisterWaiter = undefined;
      validatorVerificationState.set(discordId, st);
    }
  } catch {}

  if (timestampIso) {
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const txTimestamp = Math.floor(new Date(timestampIso).getTime() / 1000);
    if (!Number.isFinite(txTimestamp) || currentTimestamp - txTimestamp > 3600) {
      try {
        const ch = await client.channels.fetch(threadId);
        await ch.send(MSGS.txExpired);
      } catch {}
      return;
    }
  }

  const txExists = await pool.query(
    "SELECT 1 FROM verifications WHERE tx_hash = $1",
    [txHash]
  );
  if (txExists.rowCount > 0) {
    try {
      const ch = await client.channels.fetch(threadId);
      await ch.send(MSGS.txAlreadyUsed);
    } catch {}
    return;
  }

  let isSuspended = "no";
  try {
    const poolStatusCmd = `${CLIENT_PATH} pool status ${validatorId} --grpc-ip ${GRPC_IP} --grpc-port ${GRPC_PORT} ${SECURE_FLAG}`.trim();
    const poolOutput = await runCommandWithRetry(poolStatusCmd);
    const suspensionMatch = poolOutput.match(/Suspended:\s+(Yes|No)/i);
    if (suspensionMatch && suspensionMatch[1].toLowerCase() === "yes") {
      isSuspended = "yes";
    }
  } catch {
  }

  await pool.query(
    `INSERT INTO verifications (
      tx_hash, wallet_address, discord_id, role_type, is_suspended, validator_id,
      last_notified_suspended
    ) VALUES ($1, $2, $3, $4, $5, $6, $5)`,
    [txHash, validatorAddress, discordId, "Validator", isSuspended, parseInt(validatorId, 10)]
  );

  try {
    const commissionCheck = await pool.query(
      "SELECT 1 FROM validator_commissions WHERE validator_id = $1",
      [Number(validatorId)]
    );
    if (commissionCheck.rowCount === 0) {
      const commissionCmd = `${CLIENT_PATH} pool status ${validatorId} --grpc-ip ${GRPC_IP} --grpc-port ${GRPC_PORT} ${SECURE_FLAG}`.trim();
      try {
        const stdout = await runCommandWithRetry(commissionCmd);
        const bakingMatch = stdout.match(/Baking:\s+([0-9.eE+-]+)/);
        const txMatch = stdout.match(/Transaction fees:\s+([0-9.eE+-]+)/);

        const bakingRate = bakingMatch ? parseFloat(bakingMatch[1]) : null;
        const transactionFeeRate = txMatch ? parseFloat(txMatch[1]) : null;

        if (bakingRate !== null && transactionFeeRate !== null) {
          await pool.query(
            `INSERT INTO validator_commissions (
              validator_id, baking_rate, transaction_fee_rate, last_checked_at,
              last_notified_baking_rate, last_notified_transaction_fee_rate
            ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $2, $3)`,
            [Number(validatorId), bakingRate, transactionFeeRate]
          );
        }
      } catch {
      }
    }
  } catch {
  }

  const guild = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(discordId);
  await member.roles.add(VALIDATOR_ROLE_ID);
  console.log(
    `[${new Date().toISOString()}][VERIFICATION] Assigned validator role to user ${discordId} (${validatorAddress})`
  );

  try {
    const modChannel = await client.channels.fetch(MOD_LOGS_CHANNEL_ID);
    if (modChannel?.isTextBased?.()) {
      await modChannel.send(
        MSGS.modLogsValidatorAssigned(VALIDATOR_ROLE_ID, discordId)
      );
    }
  } catch {}

  try {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("archive_thread_validator")
        .setLabel("🗑️ Delete this thread")
        .setStyle(ButtonStyle.Secondary)
    );
    const ch = await client.channels.fetch(threadId);
    await ch.send({
      content: MSGS.verificationSuccess(VALIDATOR_ROLE_ID, VALIDATOR_CHANNEL_ID),
      allowedMentions: { parse: [] },
      components: [row],
    });
  } catch {}

  try {
    await refreshValidatorDelegators(validatorId);
    if (process.env.TXL_DEBUG === "1") {
      console.log(`[verify][validator] synced delegators for pool #${validatorId}`);
    }
  } catch (e) {
    console.warn(
      `[verify][validator] failed to sync delegators for #${validatorId}:`,
      e?.message || e
    );
  }

  validatorVerificationState.set(discordId, { completed: true });
}

async function handleValidatorVerification(interaction, discordId, client) {
  ensureWrongMemoNotifier(client);
  ensureValidatorExpiredNotifier(client);

  for (const [userId, state] of validatorVerificationState.entries()) {
    if (state.threadId) {
      const exists = await client.channels
        .fetch(state.threadId)
        .catch(() => null);
      if (!exists) {
        validatorVerificationState.delete(userId);
        console.log(
          "Removed validatorVerificationState for",
          userId,
          "because thread does not exist"
        );
      }
    }
  }

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);

    if (member.roles.cache.has(VALIDATOR_ROLE_ID)) {
      await interaction.reply({
        content: MSGS.alreadyHasRole,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (validatorVerificationState.has(discordId)) {
      const existing = validatorVerificationState.get(discordId);
      const existingThread = await client.channels
        .fetch(existing.threadId)
        .catch(() => null);

      if (existingThread) {
        await interaction.reply({
          content: MSGS.threadExists(GUILD_ID, existingThread.id),
          flags: MessageFlags.Ephemeral
        });
        return;
      } else {
        validatorVerificationState.delete(discordId);
      }
    }

    startInactiveThreadsCleanup({
      client,
      stateMap: validatorVerificationState,
      threadPrefix: "validator-",
      channelId: CLAIM_CHANNEL_ID,
    });

    const verificationChannel = await client.channels.fetch(CLAIM_CHANNEL_ID);
    const thread = await verificationChannel.threads.create({
      name: `validator-${interaction.user.username}-${interaction.user.id}`,
      type: ChannelType.PrivateThread,
      autoArchiveDuration: 60,
      reason: `Validator verification for ${interaction.user.tag}`,
      invitable: false,
    });

    await thread.members.add(interaction.user.id);

    validatorVerificationState.set(discordId, {
      threadId: thread.id,
      step: "awaiting-validator-id",
      createdAt: Math.floor(Date.now() / 1000),
      lastActivity: Date.now(),
    });

    await interaction.reply({
      content: MSGS.verificationStarted(GUILD_ID, thread.id),
      flags: MessageFlags.Ephemeral,
    });

    await thread.send(MSGS.introThread(interaction.user.id));
  } catch (err) {
    console.error("Validator verification thread error:", err);
    await interaction.reply({
      content: MSGS.failedToStartValidatorVerification,
      flags: MessageFlags.Ephemeral,
    });
  }
}

function listenForValidatorMessages(client) {
  ensureValidatorRemovalWatcher(client);

  client.on("messageCreate", async (message) => {
    if (!message.channel.isThread()) return;
    if (message.author.bot) return;

    const state = validatorVerificationState.get(message.author.id);
    if (state?.completed) return;
    if (!state) {
      if (message.channel.name.startsWith("validator-")) {
        await message.reply(MSGS.verificationInactive(CLAIM_CHANNEL_ID));
      }
      return;
    }
    if (state.threadId !== message.channel.id) return;

    state.lastActivity = Date.now();
    validatorVerificationState.set(message.author.id, state);

    if (state.step === "awaiting-validator-id") {
      const validatorId = message.content.trim();
      if (!/^\d+$/.test(validatorId)) {
        return message.reply(MSGS.invalidValidatorId);
      }

      const cmd = `${CLIENT_PATH} consensus show-parameters --include-bakers --grpc-ip ${GRPC_IP} --grpc-port ${GRPC_PORT} ${SECURE_FLAG} | awk '$1 ~ /^${validatorId}:$/ {print $2}'`.trim();

      try {
        const stdout = await runCommandWithRetry(cmd);
        if (isGrpcUnavailable(stdout)) {
          return message.reply(MSGS.grpcUnavailable);
        }

        if (!stdout.trim()) {
          return message.reply(MSGS.validatorIdNotFound);
        }

        const validatorAddress = stdout.trim();

        for (const [userId, session] of validatorVerificationState.entries()) {
          if (session.threadId) {
            const exists = await message.client.channels
              .fetch(session.threadId)
              .catch(() => null);
            if (!exists) {
              validatorVerificationState.delete(userId);
              console.log(
                "Removed validatorVerificationState for",
                userId,
                "because thread does not exist"
              );
            }
          }
        }

        const isInActiveSession = Array.from(
          validatorVerificationState.values()
        ).some(
          (session) =>
            !!session.validatorAddress &&
            session.validatorAddress === validatorAddress &&
            session.threadId !== message.channel.id
        );
        if (isInActiveSession) {
          return message.reply(MSGS.validatorAlreadyInVerification);
        }

        const exists = await pool.query(
          "SELECT * FROM verifications WHERE wallet_address = $1 AND role_type = 'Validator'",
          [validatorAddress]
        );
        if (exists.rowCount > 0) {
          return message.reply(MSGS.validatorAlreadyRegistered);
        }

        const randomMemo = generateRandomMemo();

        validatorVerificationState.set(message.author.id, {
          ...state,
          step: "awaiting-tx-hash",
          validatorId,
          validatorAddress,
          randomMemo,
          lastActivity: Date.now(),
        });

        await message.reply(MSGS.addressConfirmed(validatorAddress, randomMemo));

        const unregister = registerValidatorMemoWaiter({
          discordId: message.author.id,
          threadId: message.channel.id,
          validatorId: parseInt(validatorId, 10),
          validatorAddress,
          expectedMemo: randomMemo,
          onSuccess: async ({
            txHash,
            blockHash,
            timestampIso,
          }) => {
            try {
              const st = validatorVerificationState.get(message.author.id);
              st?.unregisterWaiter?.();
              if (st) {
                st.unregisterWaiter = undefined;
                validatorVerificationState.set(message.author.id, st);
              }
            } catch {}

            await finalizeValidatorVerificationViaTxLogger({
              client: message.client,
              discordId: message.author.id,
              threadId: message.channel.id,
              validatorId: parseInt(validatorId, 10),
              validatorAddress,
              txHash,
              blockHash,
              timestampIso,
            });
          },
        });

        validatorVerificationState.set(message.author.id, {
          ...validatorVerificationState.get(message.author.id),
          unregisterWaiter: unregister,
        });
      } catch (err) {
        if (isGrpcUnavailable(err?.message || "" + (err || ""))) {
          return message.reply(MSGS.grpcUnavailable);
        }
        return message.reply(MSGS.errorCheckingValidatorId);
      }
    }

    if (state.step === "awaiting-tx-hash") {
      await message.reply(
        "There is no need to send the transaction hash - I will automatically track it by memo and address after finalization."
      );
      return;
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;

    if (interaction.customId === "archive_thread_validator") {
      try {
        await interaction.channel.delete(
          "Thread deleted after successful validator verification."
        );
      } catch (err) {
        await interaction.reply({
          content: MSGS.failedToArchiveThread,
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  });

  client.on("channelDelete", async (channel) => {
    if (
      channel.type === ChannelType.PrivateThread &&
      channel.name.startsWith("validator-")
    ) {
      for (const [discordId, state] of validatorVerificationState.entries()) {
        if (state.threadId === channel.id) {
          try {
            state.unregisterWaiter?.();
          } catch {}
          validatorVerificationState.delete(discordId);
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
        content: MSGS.noActiveValidatorThread(CLAIM_CHANNEL_ID),
        flags: MessageFlags.Ephemeral,
      });
    }

    const thread = await client.channels
      .fetch(existingState.threadId)
      .catch(() => null);
    if (!thread) {
      validatorVerificationState.delete(discordId);
      return interaction.reply({
        content: MSGS.previousThreadNotFound(CLAIM_CHANNEL_ID),
        flags: MessageFlags.Ephemeral,
      });
    }

      try {
      existingState.unregisterWaiter?.();
    } catch {}

    validatorVerificationState.set(discordId, {
      threadId: thread.id,
      step: "awaiting-validator-id",
      createdAt: Math.floor(Date.now() / 1000),
      lastActivity: Date.now(),
    });

    await thread.send(MSGS.verificationRestarted(interaction.user.id));
    await interaction.reply({
      content: MSGS.flowRestarted,
      flags: MessageFlags.Ephemeral,
    });
  },
};