// roles/delegatorVerification.js
/**
 * Orchestrates the **Delegator** verification flow for the Discord bot.
 * Responsibilities:
 * - Creates and manages private verification threads; guides users to submit their account address.
 * - Validates address & delegation on-chain via `concordium-client` (requires ≥ 1000 CCD staked).
 * - Generates a numeric MEMO and auto-detects the confirming transaction through txlogger listeners.
 * - Handles wrong-MEMO and timeout notifications; unregisters memo waiters safely.
 * - On success: inserts a row into Postgres (`verifications`, optional `validator_commissions` seed),
 *   assigns the Delegator role, posts a mod-log message, and offers a “Delete this thread” button.
 * - Watches the chain (Concordium gRPC/web-sdk) for `DelegationRemoved` to revoke roles and purge DB rows.
 * - Prevents duplicates (active sessions, already-registered addresses, reused tx hashes) and supports flow restarts.
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

let _txl = null;
async function _getTxl() {
  if (_txl) return _txl;
  const m = await import("../modules/txloggerListener.js");
  _txl = m.default || m;
  return _txl;
}

function setDelegatorWrongMemoNotifier(fn) {
  _getTxl().then(m => m.setDelegatorWrongMemoNotifier(fn)).catch(() => {});
}
function setDelegatorWaiterExpiredNotifier(fn) {
  _getTxl().then(m => m.setDelegatorWaiterExpiredNotifier(fn)).catch(() => {});
}
function registerDelegatorMemoWaiter(args) {
  let unsubscribe = () => {};
  _getTxl().then(m => {
    try {
      const u = m.registerDelegatorMemoWaiter(args);
      if (typeof u === "function") unsubscribe = u;
    } catch {}
  });
  return () => { try { unsubscribe(); } catch {} };
}

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CLAIM_CHANNEL_ID = process.env.CLAIM_CHANNEL_ID;
const DELEGATOR_ROLE_ID = process.env.DELEGATOR_ROLE_ID;
const CLIENT_PATH = process.env.CONCORDIUM_CLIENT_PATH;
const GRPC_IP = process.env.GRPC_IP;
const GRPC_PORT = process.env.GRPC_PORT;
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

const delegatorVerificationState = new Map();

let wrongMemoNotifierInitialized = false;
function ensureWrongMemoNotifier(client) {
  if (wrongMemoNotifierInitialized) return;
  setDelegatorWrongMemoNotifier(async ({ threadId, expected }) => {
    try {
      const ch = await client.channels.fetch(threadId);
      await ch.send(MSGS.DelegationtxWrongMemo(expected));
    } catch {
    }
  });
  wrongMemoNotifierInitialized = true;
}

let delegatorExpiredNotifierInitialized = false;
function ensureDelegatorExpiredNotifier(client) {
  if (delegatorExpiredNotifierInitialized) return;
  setDelegatorWaiterExpiredNotifier(async ({ threadId, minutes }) => {
    try {
      const ch = await client.channels.fetch(threadId);
      await ch.send(
        `⏲️ The verification timed out (no transaction with the expected memo within ${minutes} minutes).\n` +
          `Please use \`/start-again-delegator\` to restart and get a new code.`
      );
    } catch {}
  });
  delegatorExpiredNotifierInitialized = true;
}

let delegatorRemovalWatcherStarted = false;

async function ensureDelegatorRemovalWatcher(client) {
  if (delegatorRemovalWatcherStarted) return;
  delegatorRemovalWatcherStarted = true;

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
                if (tag !== "DelegationRemoved") continue;

                const accRaw = ev?.account || ev?.address || ev?.owner;
                const accountBase58 =
                  typeof accRaw === "string"
                    ? accRaw
                    : (accRaw?.account ?? accRaw?.address ?? accRaw?.value ?? null);

                if (!accountBase58) continue;

                const rows = await pool.query(
                  "SELECT id, discord_id FROM verifications WHERE role_type='Delegator' AND wallet_address = $1",
                  [String(accountBase58)]
                );
                if (rows.rowCount === 0) continue;

                for (const r of rows.rows) {
                  const discordId = r.discord_id;

                  try {
                    const guild = await client.guilds.fetch(GUILD_ID);
                    const member = await guild.members.fetch(discordId).catch(() => null);
                    if (member?.roles?.cache?.has?.(DELEGATOR_ROLE_ID)) {
                      await member.roles.remove(DELEGATOR_ROLE_ID);
                    }
                  } catch {}

                  try {
                    const user = await client.users.fetch(discordId).catch(() => null);
                    if (user) {
                      await user.send(
                        "⌛ We detected you **stopped delegating** on-chain.\n" +
                          "Your **Delegator** role has been removed. If you start delegating again, use the verification menu to restore the role."
                      );
                    }
                  } catch {}

                  try {
                    const ch = await client.channels.fetch(MOD_LOGS_CHANNEL_ID).catch(() => null);
                    if (ch?.isTextBased?.()) {
                      await ch.send(
                        `🧹 Removed **Delegator** role & DB record for <@${discordId}> (address \`${accountBase58}\`) after delegation stopped.`
                      );
                    }
                  } catch {}
                }

                try {
                  await pool.query(
                    "DELETE FROM verifications WHERE role_type='Delegator' AND wallet_address = $1",
                    [String(accountBase58)]
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
        console.error(`[delegator-watch] error: ${e?.message || e}. Reconnecting in 1s...`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  })();
}

async function finalizeDelegatorVerificationViaTxLogger({
  client,
  discordId,
  threadId,
  delegatorAddress,
  delegationTarget,
  txHash,
  timestampIso,
}) {
  try {
    const st = delegatorVerificationState.get(discordId);
    st?.unregisterWaiter?.();
    if (st) {
      st.unregisterWaiter = undefined;
      delegatorVerificationState.set(discordId, st);
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

  let pool_suspended = "no";
  if (delegationTarget !== "passive" && delegationTarget !== null) {
    const poolStatusCmd = `${CLIENT_PATH} pool status ${delegationTarget} --grpc-ip ${GRPC_IP} --grpc-port ${GRPC_PORT} ${SECURE_FLAG}`.trim();
    try {
      const poolOutput = await runCommandWithRetry(poolStatusCmd);
      const suspensionMatch = poolOutput.match(/Suspended:\s+(Yes|No)/i);
      if (suspensionMatch && suspensionMatch[1].toLowerCase() === "yes") {
        pool_suspended = "yes";
      } else if (
        /Missed rounds:.*\(suspension is pending\)/i.test(poolOutput)
      ) {
        pool_suspended = "suspension_is_pending";
      }
    } catch {
    }
  }

  await pool.query(
    `INSERT INTO verifications (
      tx_hash, wallet_address, discord_id, role_type, delegation_target,
      last_notified_delegation_target, last_notified_suspended
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      txHash,
      delegatorAddress,
      discordId,
      "Delegator",
      delegationTarget === "passive" ? "passive" : String(delegationTarget),
      delegationTarget === "passive" ? "passive" : String(delegationTarget),
      pool_suspended,
    ]
  );

  if (delegationTarget !== "passive") {
    const poolId = delegationTarget;
    const checkValidatorQuery =
      "SELECT 1 FROM validator_commissions WHERE validator_id = $1";
    const checkResult = await pool.query(checkValidatorQuery, [poolId]);

    if (checkResult.rowCount === 0) {
      const commissionCmd = `${CLIENT_PATH} pool status ${poolId} --grpc-ip ${GRPC_IP} --grpc-port ${GRPC_PORT} ${SECURE_FLAG}`.trim();
      let commissionOutput;
      try {
        commissionOutput = await runCommandWithRetry(commissionCmd);
      } catch {
      }

      if (commissionOutput) {
        const bakingMatch = commissionOutput.match(/Baking:\s+([0-9.eE+-]+)/);
        const txMatch =
          commissionOutput.match(/Transaction fees:\s+([0-9.eE+-]+)/);

        const bakingRate = bakingMatch ? parseFloat(bakingMatch[1]) : null;
        const transactionFeeRate = txMatch ? parseFloat(txMatch[1]) : null;

        if (bakingRate !== null && transactionFeeRate !== null) {
          await pool.query(
            `INSERT INTO validator_commissions (
              validator_id, baking_rate, transaction_fee_rate, last_checked_at,
              last_notified_baking_rate, last_notified_transaction_fee_rate
            ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $2, $3)`,
            [poolId, bakingRate, transactionFeeRate]
          );
        }
      }
    }
  }

  const guild = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(discordId);
  await member.roles.add(DELEGATOR_ROLE_ID);
  console.log(
    `[${new Date().toISOString()}][VERIFICATION] Assigned delegator role to user ${discordId} (${delegatorAddress})`
  );

  try {
    const modChannel = await client.channels.fetch(MOD_LOGS_CHANNEL_ID);
    if (modChannel?.isTextBased?.()) {
      await modChannel.send(
        MSGS.modLogsDelegatorAssigned(DELEGATOR_ROLE_ID, discordId)
      );
    }
  } catch {}

  try {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("archive_thread_delegator")
        .setLabel("🗑️ Delete this thread")
        .setStyle(ButtonStyle.Secondary)
    );
    const ch = await client.channels.fetch(threadId);

    const successMsg =
      delegationTarget === "passive"
        ? MSGS.passiveDelegatorVerificationSuccess(DELEGATOR_ROLE_ID)
        : MSGS.delegatorVerificationSuccess(DELEGATOR_ROLE_ID);

    await ch.send({
      content: successMsg,
      allowedMentions: { parse: [] },
      components: [row],
    });
  } catch {}

  delegatorVerificationState.set(discordId, { completed: true });
}

async function handleDelegatorVerification(interaction, discordId, client) {
  ensureWrongMemoNotifier(client);
  ensureDelegatorExpiredNotifier(client);

  for (const [userId, state] of delegatorVerificationState.entries()) {
    if (state.threadId) {
      const exists = await client.channels
        .fetch(state.threadId)
        .catch(() => null);
      if (!exists) {
        delegatorVerificationState.delete(userId);
        console.log(
          "Removed delegatorVerificationState for",
          userId,
          "because thread does not exist"
        );
      }
    }
  }

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);

    if (member.roles.cache.has(DELEGATOR_ROLE_ID)) {
      await interaction.reply({
        content: MSGS.alreadyHasDelegatorRole,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (delegatorVerificationState.has(discordId)) {
      const existing = delegatorVerificationState.get(discordId);
      const existingThread = await client.channels
        .fetch(existing.threadId)
        .catch(() => null);

      if (existingThread) {
        await interaction.reply({
          content: MSGS.delegatorThreadExists(GUILD_ID, existingThread.id),
          flags: MessageFlags.Ephemeral,
        });
        return;
      } else {
        delegatorVerificationState.delete(discordId);
      }
    }

    startInactiveThreadsCleanup({
      client,
      stateMap: delegatorVerificationState,
      threadPrefix: "delegator-",
      channelId: CLAIM_CHANNEL_ID,
    });

    const verificationChannel = await client.channels.fetch(CLAIM_CHANNEL_ID);
    const thread = await verificationChannel.threads.create({
      name: `delegator-${interaction.user.username}-${interaction.user.id}`,
      type: ChannelType.PrivateThread,
      autoArchiveDuration: 60,
      reason: `Delegator verification for ${interaction.user.tag}`,
      invitable: false,
    });

    await thread.members.add(interaction.user.id);

    delegatorVerificationState.set(discordId, {
      threadId: thread.id,
      step: "awaiting-account-address",
      createdAt: Math.floor(Date.now() / 1000),
      lastActivity: Date.now(),
    });

    await interaction.reply({
      content: MSGS.delegatorVerificationStarted(GUILD_ID, thread.id),
      flags: MessageFlags.Ephemeral,
    });

    await thread.send(MSGS.delegatorIntroThread(interaction.user.id));
  } catch (err) {
    console.error("Delegator verification thread error:", err);
    await interaction.reply({
      content: MSGS.failedToStartDelegatorVerification,
      flags: MessageFlags.Ephemeral,
    });
  }
}

function listenForDelegatorMessages(client) {
  ensureDelegatorRemovalWatcher(client);

  client.on("messageCreate", async (message) => {
    if (!message.channel.isThread()) return;
    if (message.author.bot) return;

    const state = delegatorVerificationState.get(message.author.id);
    if (state?.completed) return;
    if (!state) {
      if (message.channel.name.startsWith("delegator-")) {
        await message.reply(MSGS.verificationInactive(CLAIM_CHANNEL_ID));
      }
      return;
    }
    if (state.threadId !== message.channel.id) return;

    state.lastActivity = Date.now();
    delegatorVerificationState.set(message.author.id, state);

    if (state.step === "awaiting-account-address") {
      const address = message.content.trim();

      for (const [userId, session] of delegatorVerificationState.entries()) {
        if (session.threadId) {
          const exists = await message.client.channels
            .fetch(session.threadId)
            .catch(() => null);
          if (!exists) {
            delegatorVerificationState.delete(userId);
            console.log(
              "Removed delegatorVerificationState for",
              userId,
              "because thread does not exist"
            );
          }
        }
      }

      const isInActiveSession = Array.from(
        delegatorVerificationState.values()
      ).some(
        (session) =>
          !!session.delegatorAddress &&
          session.delegatorAddress === address &&
          session.threadId !== message.channel.id
      );
      if (isInActiveSession) {
        return message.reply(MSGS.delegatorAddressInVerification);
      }

      if (!/^[1-9A-HJ-NP-Za-km-z]{50,60}$/.test(address)) {
        return message.reply(MSGS.invalidDelegatorAddress);
      }

      const exists = await pool.query(
        "SELECT * FROM verifications WHERE wallet_address = $1 AND role_type = 'Delegator'",
        [address]
      );
      if (exists.rowCount > 0) {
        return message.reply(MSGS.delegatorAlreadyRegistered);
      }

      const cmd = `${CLIENT_PATH} account show ${address} --grpc-ip ${GRPC_IP} --grpc-port ${GRPC_PORT} ${SECURE_FLAG}`.trim();
      let stdout;
      try {
        stdout = await runCommandWithRetry(cmd);
        if (isGrpcUnavailable(stdout)) {
          return message.reply(MSGS.grpcUnavailable);
        }
      } catch (err) {
        const errorText = err?.message || "" + (err || "");
        if (isGrpcUnavailable(errorText)) {
          return message.reply(MSGS.grpcUnavailable);
        }
        return message.reply(MSGS.notDelegating);
      }

      if (!stdout.includes("Delegation target:")) {
        return message.reply(MSGS.notDelegating);
      }

      const stakeMatch = stdout.match(/Staked amount: ([\d.]+) CCD/);
      const stakedAmount = stakeMatch ? parseFloat(stakeMatch[1]) : 0;
      if (stakedAmount < 1000) {
        return message.reply(MSGS.insufficientStake(stakedAmount));
      }

      const randomMemo = generateRandomMemo();
      const delegationMatch = stdout.match(
        /Delegation target: (?:Staking pool with ID (\d+)|Passive delegation)/
      );
      const delegationTarget = delegationMatch
        ? delegationMatch[1]
          ? parseInt(delegationMatch[1])
          : "passive"
        : null;
      if (!delegationTarget) {
        return message.reply(MSGS.unknownDelegationTarget);
      }

      delegatorVerificationState.set(message.author.id, {
        ...state,
        step: "awaiting-tx-hash",
        delegationTarget,
        delegatorAddress: address,
        randomMemo,
        lastActivity: Date.now(),
      });

      await message.reply(
        MSGS.delegatorAccountConfirmed(randomMemo, delegationTarget)
      );

      const unregister = registerDelegatorMemoWaiter({
        discordId: message.author.id,
        threadId: message.channel.id,
        accountAddress: address,
        expectedMemo: randomMemo,
        onSuccess: async ({
          txHash,
          blockHash,
          timestampIso,
        }) => {
          try {
            const st = delegatorVerificationState.get(message.author.id);
            st?.unregisterWaiter?.();
            if (st) {
              st.unregisterWaiter = undefined;
              delegatorVerificationState.set(message.author.id, st);
            }
          } catch {}

          await finalizeDelegatorVerificationViaTxLogger({
            client: message.client,
            discordId: message.author.id,
            threadId: message.channel.id,
            delegatorAddress: address,
            delegationTarget,
            txHash,
            blockHash,
            timestampIso,
          });
        },
      });

      delegatorVerificationState.set(message.author.id, {
        ...delegatorVerificationState.get(message.author.id),
        unregisterWaiter: unregister,
      });
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

    if (interaction.customId === "archive_thread_delegator") {
      try {
        await interaction.channel.delete(
          "Thread deleted after successful delegator verification."
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
      channel.name.startsWith("delegator-")
    ) {
      for (const [discordId, state] of delegatorVerificationState.entries()) {
        if (state.threadId === channel.id) {
          try {
            state.unregisterWaiter?.();
          } catch {}
          delegatorVerificationState.delete(discordId);
          break;
        }
      }
    }
  });
}

module.exports = {
  handleDelegatorVerification,
  listenForDelegatorMessages,
  restartDelegatorFlow: async function (interaction, client) {
    const discordId = interaction.user.id;

    const existingState = delegatorVerificationState.get(discordId);
    if (!existingState) {
      return interaction.reply({
        content: MSGS.noActiveDelegatorThread(CLAIM_CHANNEL_ID),
        flags: MessageFlags.Ephemeral,
      });
    }

    const thread = await client.channels
      .fetch(existingState.threadId)
      .catch(() => null);
    if (!thread) {
      delegatorVerificationState.delete(discordId);
      return interaction.reply({
        content: MSGS.previousDelegatorThreadNotFound(CLAIM_CHANNEL_ID),
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      existingState.unregisterWaiter?.();
    } catch {}

    delegatorVerificationState.set(discordId, {
      threadId: thread.id,
      step: "awaiting-account-address",
      createdAt: Math.floor(Date.now() / 1000),
      lastActivity: Date.now(),
    });

    await thread.send(MSGS.delegatorVerificationRestarted(interaction.user.id));
    await interaction.reply({
      content: MSGS.delegatorFlowRestarted,
      flags: MessageFlags.Ephemeral,
    });
  },
};