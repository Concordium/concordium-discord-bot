// modules/alerts.js
/**
 * Alerting and DM fan-out service for on-chain events (validators & delegators).
 * Responsibilities:
 * - Sends Discord DMs (via setAlertsClient) gated by per-user prefs (isNotificationsEnabled).
 * - Aggregates & deduplicates event bursts:
 *   • Commission changes (per validator, short window) → updates `validator_commissions`,
 *     compares against last_notified_* and notifies delegators of that pool.
 *   • “New delegator” sequence (Added/TargetSet/StakeIncreased in one tx) → single DM to validator owner(s).
 * - Handles validator lifecycle:
 *   • Primed for suspension / Suspended / Resumed → updates `verifications.is_suspended` & last_notified,
 *     DMs validator owners and their delegators with status-specific messages.
 *   • Validator removed → switches affected delegators to passive, prunes validator_commissions and
 *     validator_delegators rows, DMs delegators about passive delegation.
 * - Handles delegator activity:
 *   • Target changed (pool ↔ passive) → updates DB, fetches/records commissions for new pool, DMs delegator.
 *   • Stake increased/decreased → DMs delegator; on decrease, includes cooldown info (parsed via CLI).
 *   • Joined/Left pool & stake changes for a pool → DMs validator owner(s) with account, stake, time, tx.
 * - PayDay rewards:
 *   • Validator account rewards (fees + baking + finalization) → DMs validator owners with breakdown.
 *   • Delegator account rewards → DMs delegators; notes passive vs pool target.
 * - Utilities:
 *   • Uses `concordium-client` (CLI) to read account/pool details (stake, cooldowns, commissions).
 *   • Helper parsing for CLI outputs; small aggregation windows to coalesce related events.
 */
const { Pool } = require("pg");
const { MSGS, scanTxLink, scanBlockLink } = require("../utils/messages");
const { runCommandWithRetry } = require("../utils/retry");
const { isNotificationsEnabled } = require("./notificationPrefs");
const MIN_DELEGATION_CCD = Number(process.env.MIN_DELEGATION_CCD || 1000);

const DISCORD_GUILD_ID   = process.env.DISCORD_GUILD_ID;
const DELEGATOR_ROLE_ID  = process.env.DELEGATOR_ROLE_ID;

const CLIENT_PATH = process.env.CONCORDIUM_CLIENT_PATH || "concordium-client";
const GRPC_HOST   = process.env.GRPC_IP || "127.0.0.1";
const GRPC_PORT   = Number(process.env.GRPC_PORT || 20000);
const USE_TLS     =
  (process.env.GRPC_TLS || "").toLowerCase() === "true" ||
  process.env.GRPC_TLS === "1";

const {
  PG_USER, PG_HOST, PG_DATABASE, PG_PASSWORD, PG_PORT,
  MOD_LOGS_CHANNEL_ID
} = process.env;

const ALERTS_DEBUG =
  (process.env.ALERTS_DEBUG || "").toLowerCase() === "true" ||
  process.env.ALERTS_DEBUG === "1";

const pool = new Pool({
  user: PG_USER,
  host: PG_HOST,
  database: PG_DATABASE,
  password: PG_PASSWORD,
  port: PG_PORT,
});

let discordClient = null;
function setAlertsClient(client) {
  discordClient = client;
  if (ALERTS_DEBUG) console.log("📌 [alerts] client set");
}

// ───────────────────────────────
// Helpers: CLI stake/cooldown readers + formatting
// ───────────────────────────────

/** Read "Staked amount: XXX CCD" from `account show` (works for validator self-stake). */
async function getSelfStakeCCD_CLI(account) {
  if (!account) return null;
  const cmd =
    `${CLIENT_PATH} account show ${account}` +
    ` --grpc-ip ${GRPC_HOST}` +
    ` --grpc-port ${GRPC_PORT}` +
    (USE_TLS ? " --secure" : "");
  try {
    const out = await runCommandWithRetry(cmd);
    const m = out.match(/^\s*-\s*Staked amount:\s*([0-9][0-9.,]*)\s*CCD\s*$/im);
    if (!m) return null;
    const val = Number(String(m[1]).replace(/,/g, ""));
    return Number.isFinite(val) ? val : null;
  } catch (e) {
    if (ALERTS_DEBUG) console.warn("[alerts] getSelfStakeCCD_CLI failed:", e?.message || e);
    return null;
  }
}

/** Read delegator stake (only if account is delegating). */
async function getDelegatedStakeCCD_CLI(account) {
  if (!account) return null;

  const cmd =
    `${CLIENT_PATH} account show ${account}` +
    ` --grpc-ip ${GRPC_HOST}` +
    ` --grpc-port ${GRPC_PORT}` +
    (USE_TLS ? " --secure" : "");

  try {
    const out = await runCommandWithRetry(cmd);

    if (/Delegating stake:\s*no/i.test(out)) return null;

    const m = out.match(/^\s*-\s*Staked amount:\s*([0-9][0-9.,]*)\s*CCD\s*$/im);
    if (!m) return null;

    const raw = m[1].replace(/,/g, "");
    const val = Number(raw);
    return Number.isFinite(val) ? val : null;
  } catch (e) {
    if (ALERTS_DEBUG) console.warn("[alerts] CLI stake fetch failed:", e?.message || e);
    return null;
  }
}

async function getCooldowns(account) {
  const cmd =
    `${CLIENT_PATH} account show ${account}` +
    ` --grpc-ip ${GRPC_HOST}` +
    ` --grpc-port ${GRPC_PORT}` +
    (USE_TLS ? " --secure" : "");

  try {
    const out = await runCommandWithRetry(cmd);
    const idx = out.indexOf("Inactive stake in cooldown:");
    if (idx === -1) return [];

    const tail = out.slice(idx).split(/\r?\n/).slice(1, 12);
    const items = [];
    for (const line of tail) {
      const m = line.match(/^\s*([\d.,]+)\s*CCD\s+available\s+after\s+(.+?)\s*$/i);
      if (!m) continue;
      const amountNum = Number(String(m[1]).replace(/,/g, ""));
      const amountCCD = Number.isFinite(amountNum) ? fmtCCD2(amountNum, 2) : String(m[1]);
      const when = m[2].trim();
      items.push({ amountCCD, when });
    }
    return items;
  } catch (e) {
    if (ALERTS_DEBUG) console.warn("[alerts] getCooldowns failed:", e?.message || e);
    return [];
  }
}

function toCCD_bestEffort(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  if (n >= 1e10) return n / 1e6;
  return n;
}

async function sendModLog(content) {
  if (!discordClient || !MOD_LOGS_CHANNEL_ID) return;
  try {
    const ch = await discordClient.channels.fetch(MOD_LOGS_CHANNEL_ID).catch(() => null);
    if (ch?.isTextBased?.()) await ch.send(content);
  } catch (e) {
    if (ALERTS_DEBUG) console.warn("[alerts] sendModLog failed:", e?.message || e);
  }
}

async function safeDM(userId, content) {
  if (!discordClient) return false;

  try {
    const allowed = await isNotificationsEnabled(userId);
    if (!allowed) {
      if (ALERTS_DEBUG) console.log(`[alerts] notifications OFF for ${userId}, skipping DM`);
      return false;
    }
  } catch (e) {
    if (ALERTS_DEBUG) console.warn("[alerts] pref check failed:", e?.message || e);
  }

  try {
    const payload = (typeof content === "string") ? { content } : { ...content };

    if (typeof payload.content === "string" && payload.content.includes(`<@${userId}>`)) {
      payload.allowedMentions = { users: [userId], parse: [] };
    }

    await discordClient.users.send(userId, payload);
    if (ALERTS_DEBUG) console.log(`[alerts] DM sent to ${userId}`);
    return true;
  } catch (e) {
    if (ALERTS_DEBUG) console.warn(`[alerts] DM failed to ${userId}:`, e?.message || e);
    try {
      if (MOD_LOGS_CHANNEL_ID) {
        const ch = await discordClient.channels.fetch(MOD_LOGS_CHANNEL_ID).catch(() => null);
        if (ch?.isTextBased?.()) {
          await ch.send(`⚠️ Could not DM <@${userId}>: ${e?.message || e}`);
        }
      }
    } catch {}
    return false;
  }
}

const commissionBuckets = new Map();
const AGG_WINDOW_MS = 800;

async function flushCommissionBucket(key) {
  const b = commissionBuckets.get(key);
  if (!b) return;
  commissionBuckets.delete(key);

  const { validatorId, txHash } = b;
  const blockHash = b.blockHash;
  const bakingRewardCommission = typeof b.baking === "number" ? b.baking : null;
  const transactionFeeCommission = typeof b.txFee === "number" ? b.txFee : null;

  if (bakingRewardCommission == null && transactionFeeCommission == null) return;

  const res = await pool.query(
    "SELECT baking_rate, transaction_fee_rate, last_notified_baking_rate, last_notified_transaction_fee_rate FROM validator_commissions WHERE validator_id = $1",
    [Number(validatorId)]
  );

  let needUpdateBaking = false;
  let needUpdateTxFee = false;
  let prevBaking = null;
  let prevTxFee = null;

  const nearlyEqual = (a, b, eps = 1e-9) => {
    if (a == null || b == null) return false;
    return Math.abs(a - b) < eps;
  };

  if (res.rowCount === 0) {
    await pool.query(
      `INSERT INTO validator_commissions
       (validator_id, baking_rate, transaction_fee_rate, last_checked_at, last_notified_baking_rate, last_notified_transaction_fee_rate)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $2, $3)
       ON CONFLICT (validator_id) DO NOTHING`,
      [Number(validatorId), bakingRewardCommission ?? null, transactionFeeCommission ?? null]
    );

    prevBaking = bakingRewardCommission ?? null;
    prevTxFee  = transactionFeeCommission ?? null;

    needUpdateBaking = bakingRewardCommission != null;
    needUpdateTxFee  = transactionFeeCommission != null;
  } else {
    const row = res.rows[0];

    const rowLastNotifiedBaking = row.last_notified_baking_rate != null
      ? Number(row.last_notified_baking_rate)
      : null;
    const rowLastNotifiedTxFee = row.last_notified_transaction_fee_rate != null
      ? Number(row.last_notified_transaction_fee_rate)
      : null;

    prevBaking = rowLastNotifiedBaking;
    prevTxFee  = rowLastNotifiedTxFee;

    if (bakingRewardCommission != null && !nearlyEqual(bakingRewardCommission, rowLastNotifiedBaking)) {
      needUpdateBaking = true;
    }
    if (transactionFeeCommission != null && !nearlyEqual(transactionFeeCommission, rowLastNotifiedTxFee)) {
      needUpdateTxFee = true;
    }
  }

  if (!needUpdateBaking && !needUpdateTxFee) {
    if (ALERTS_DEBUG) console.log(`[alerts] commissions for ${validatorId}: no change to notify`);
    await pool.query(
      `UPDATE validator_commissions
       SET baking_rate = COALESCE($2, baking_rate),
           transaction_fee_rate = COALESCE($3, transaction_fee_rate),
           last_checked_at = CURRENT_TIMESTAMP
       WHERE validator_id = $1`,
      [Number(validatorId), bakingRewardCommission, transactionFeeCommission]
    );
    return;
  }

  await pool.query(
    `UPDATE validator_commissions
     SET baking_rate = COALESCE($2, baking_rate),
         transaction_fee_rate = COALESCE($3, transaction_fee_rate),
         last_checked_at = CURRENT_TIMESTAMP,
         last_notified_baking_rate = COALESCE($2, last_notified_baking_rate),
         last_notified_transaction_fee_rate = COALESCE($3, last_notified_transaction_fee_rate)
     WHERE validator_id = $1`,
    [Number(validatorId), bakingRewardCommission, transactionFeeCommission]
  );

  const delegators = await pool.query(
    "SELECT DISTINCT discord_id FROM verifications WHERE role_type='Delegator' AND delegation_target=$1",
    [String(validatorId)]
  );
  const recipients = [...new Set(delegators.rows.map(r => r.discord_id))];

  if (recipients.length === 0) {
    if (ALERTS_DEBUG) console.log(`[alerts] no delegators to notify for commissions change v${validatorId}`);
    return;
  }

  const oldBaking = (prevBaking ?? bakingRewardCommission ?? 0);
  const newBaking = (bakingRewardCommission ?? prevBaking ?? 0);
  const oldTx     = (prevTxFee ?? transactionFeeCommission ?? 0);
  const newTx     = (transactionFeeCommission ?? prevTxFee ?? 0);

  for (const uid of recipients) {
    const mention = `<@${uid}>`;
    const body = MSGS.commissionChanged(mention, validatorId, oldBaking, newBaking, oldTx, newTx);
    await safeDM(uid, body);
  }
}

async function handleDelegatorLeftPool({ validatorId, delegatorId, account, txHash, timestampIso }) {
  const vid = Number(validatorId);
  if (!Number.isFinite(vid)) return;

  const owners = await pool.query(
    "SELECT DISTINCT discord_id FROM verifications WHERE role_type='Validator' AND validator_id = $1",
    [vid]
  );
  if (owners.rowCount === 0) return;

  for (const row of owners.rows) {
    const uid = row.discord_id;
    const mention = `<@${uid}>`;
    const msg = MSGS.delegatorLeftPool(
      mention,
      String(vid),
      account || "unknown",
      String(delegatorId),
      timestampIso || null,
      txHash || null
    );
    try {
      await safeDM(uid, msg);
    } catch {}
  }
}

async function handleDelegatorJoinedPool({ validatorId, delegatorId, account, txHash, timestampIso }) {
  const vidNum = Number(validatorId);
  const stakeCCD = await getDelegatedStakeCCD_CLI(account);
  if (!Number.isFinite(vidNum)) return;

  let owners;
  try {
    owners = await pool.query(
      "SELECT DISTINCT discord_id FROM verifications WHERE role_type='Validator' AND validator_id=$1",
      [vidNum]
    );
  } catch (e) {
    if (ALERTS_DEBUG) console.warn("[alerts] handleDelegatorJoinedPool: DB query failed:", e?.message || e);
    return;
  }
  if (!owners || owners.rowCount === 0) return;

  for (const row of owners.rows) {
    const uid = row.discord_id;
    const mention = `<@${uid}>`;
    const msg = MSGS.delegatorJoinedPool(
      mention,
      String(vidNum),
      account || "unknown",
      String(delegatorId),
      timestampIso || null,
      txHash || null,
      stakeCCD
    );
    try {
      await safeDM(uid, msg);
    } catch (e) {
      if (ALERTS_DEBUG) console.warn("[alerts] handleDelegatorJoinedPool: DM failed:", e?.message || e);
    }
  }
}

async function handleValidatorRemoved({ validatorId }) {
  const poolIdStr = String(validatorId);
  const poolIdInt = Number(validatorId);

  const res = await pool.query(
    "SELECT id, discord_id, wallet_address FROM verifications WHERE role_type='Delegator' AND delegation_target=$1",
    [poolIdStr]
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (Number.isFinite(poolIdInt)) {
      const delCom = await client.query(
        "DELETE FROM validator_commissions WHERE validator_id = $1",
        [poolIdInt]
      );
      if (ALERTS_DEBUG) {
        console.log(
          `[alerts] validator #${poolIdInt} removed: deleted ${delCom.rowCount} row(s) from validator_commissions`
        );
      }

      const delDelegs = await client.query(
        "DELETE FROM validator_delegators WHERE validator_id = $1",
        [poolIdInt]
      );
      if (ALERTS_DEBUG) {
        console.log(
          `[alerts] validator #${poolIdInt} removed: deleted ${delDelegs.rowCount} row(s) from validator_delegators`
        );
      }
    }

    await client.query(
      "UPDATE verifications SET delegation_target='passive', last_notified_delegation_target='passive' WHERE role_type='Delegator' AND delegation_target=$1",
      [poolIdStr]
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    if (ALERTS_DEBUG) {
      console.warn(`[alerts] handleValidatorRemoved TX failed for #${poolIdStr}:`, e?.message || e);
    }
    return;
  } finally {
    client.release();
  }

  if (res.rowCount === 0) {
    if (ALERTS_DEBUG) console.log(`[alerts] no delegators to update for removed validator #${poolIdStr}`);
    return;
  }

  for (const row of res.rows) {
    const uid = row.discord_id;
    const mention = `<@${uid}>`;
    const msg = MSGS.delegationBecamePassive(mention, row.wallet_address);
    await safeDM(uid, msg);
  }
}

function parsePoolStatusCommissions(out) {
  const num = (s) => {
    if (!s) return null;
    const n = Number(String(s).trim().replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };

  const mB = out.match(/^\s*-\s*Baking:\s*([0-9.,]+)/mi);
  const mT = out.match(/^\s*-\s*Transaction\s+fees?:\s*([0-9.,]+)/mi);

  return {
    baking: num(mB && mB[1]),
    txFee:  num(mT && mT[1]),
  };
}

async function fetchPoolCommissions(poolId) {
  const cmd =
    `${CLIENT_PATH} pool status ${poolId}` +
    ` --grpc-ip ${GRPC_HOST}` +
    ` --grpc-port ${GRPC_PORT}` +
    (USE_TLS ? " --secure" : "");
  try {
    const out = await runCommandWithRetry(cmd);
    const { baking, txFee } = parsePoolStatusCommissions(out || "");
    if (ALERTS_DEBUG) {
      console.log(`[alerts] fetched commissions for pool ${poolId}:`, { baking, txFee });
    }
    return { baking, txFee };
  } catch (e) {
    if (ALERTS_DEBUG) console.warn(`[alerts] fetchPoolCommissions failed for ${poolId}:`, e?.message || e);
    return { baking: null, txFee: null };
  }
}

async function upsertCommissionRowCurrent(validatorId, baking, txFee) {
  const id = Number(validatorId);
  if (!Number.isFinite(id)) return;

  await pool.query(
    `INSERT INTO validator_commissions
       (validator_id, baking_rate, transaction_fee_rate, last_checked_at,
        last_notified_baking_rate, last_notified_transaction_fee_rate)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $2, $3)
     ON CONFLICT (validator_id) DO UPDATE
       SET baking_rate = EXCLUDED.baking_rate,
           transaction_fee_rate = EXCLUDED.transaction_fee_rate,
           last_checked_at = CURRENT_TIMESTAMP`,
    [id, baking, txFee]
  );
}

async function handleDelegationTargetChanged({ account, newTarget }) {
  const rows = await pool.query(
    "SELECT id, discord_id, delegation_target, last_notified_delegation_target FROM verifications WHERE role_type='Delegator' AND wallet_address=$1",
    [String(account)]
  );

  if (rows.rowCount === 0) {
    if (ALERTS_DEBUG) console.log(`[alerts] target change: no delegator row for ${account}`);
    return;
  }

  const targetStr = String(newTarget);
  const needNotify = [];

  for (const r of rows.rows) {
    const prev = r.last_notified_delegation_target || r.delegation_target || null;
    if (prev !== targetStr) {
      needNotify.push(r.discord_id);
    }
  }

  await pool.query(
    "UPDATE verifications SET delegation_target=$2, last_notified_delegation_target=$2 WHERE role_type='Delegator' AND wallet_address=$1",
    [String(account), targetStr]
  );

  if (targetStr !== "passive") {
    try {
      const { baking, txFee } = await fetchPoolCommissions(targetStr);
      if (baking != null && txFee != null) {
        await upsertCommissionRowCurrent(targetStr, baking, txFee);
      } else if (ALERTS_DEBUG) {
        console.warn(`[alerts] commissions not found for pool ${targetStr}, skip upsert`);
      }
    } catch (e) {
      if (ALERTS_DEBUG) console.warn(`[alerts] upsert commissions failed for pool ${targetStr}:`, e?.message || e);
    }
  }

  for (const uid of new Set(needNotify)) {
    const mention = `<@${uid}>`;
    const msg = MSGS.delegationTargetChanged(mention, account, targetStr);
    await safeDM(uid, msg);
  }
}

async function handleCommissionUpdate({ validatorId, bakingRewardCommission, transactionFeeCommission, blockHash, txHash }) {
  if (!validatorId) return;

  if (!txHash) {
    const key = `${validatorId}:__nohash__:${Date.now()}`;
    commissionBuckets.set(key, {
      validatorId,
      txHash: null,
      blockHash,
      baking: bakingRewardCommission ?? undefined,
      txFee: transactionFeeCommission ?? undefined,
      timer: null
    });
    await flushCommissionBucket(key);
    return;
  }

  const key = `${validatorId}:${txHash}`;
  let b = commissionBuckets.get(key);
  if (!b) {
    b = { validatorId, txHash, blockHash: undefined, baking: undefined, txFee: undefined, timer: null };
    commissionBuckets.set(key, b);
  }
  if (blockHash) b.blockHash = blockHash;
  if (typeof bakingRewardCommission === "number") b.baking = bakingRewardCommission;
  if (typeof transactionFeeCommission === "number") b.txFee = transactionFeeCommission;

  if (!b.timer) {
    b.timer = setTimeout(() => flushCommissionBucket(key), AGG_WINDOW_MS);
    if (typeof b.timer.unref === "function") b.timer.unref();
  }
}

// ——— formatting utils (used across alerts) ———
function normPaydayCCD(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Number.isInteger(n) && Math.abs(n) >= 1e4 ? n / 1e6 : n;
}
function fmtCCD(n) {
  return (Number(n) || 0).toFixed(6).replace(/\.?0+$/, "");
}
function fmtCCD2(n, fractionDigits = 2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "unknown";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

async function handleValidatorPaydayAccountReward({
  account,
  transactionFees = 0,
  bakerReward = 0,
  finalizationReward = 0,
  blockHash,
}) {
  if (!account) return;

  const res = await pool.query(
    "SELECT discord_id, validator_id FROM verifications WHERE role_type='Validator' AND wallet_address=$1",
    [String(account)]
  );
  if (res.rowCount === 0) {
    if (ALERTS_DEBUG) console.log(`[alerts] paydayAccountReward for ${account}: no validator recipients`);
    return;
  }

  const feesCCD   = normPaydayCCD(transactionFees);
  const bakingCCD = normPaydayCCD(bakerReward);
  const finalCCD  = normPaydayCCD(finalizationReward);

  const totalCCD        = fmtCCD(feesCCD + bakingCCD + finalCCD);
  const bakingPlusFinal = fmtCCD(bakingCCD + finalCCD);
  const feesStr         = fmtCCD(feesCCD);

  const recipients = [...new Set(res.rows.map(r => r.discord_id))];

  for (const uid of recipients) {
    const mention = `<@${uid}>`;
    const payload = MSGS.validatorPaydayReward(
      mention,
      totalCCD,
      bakingPlusFinal,
      feesStr,
      blockHash
    );
    await safeDM(uid, payload);
  }
}

async function getDelegatorDiscordIdsByValidator(validatorId) {
  const idStr = String(validatorId);
  try {
    const res = await pool.query(
      "SELECT DISTINCT discord_id FROM verifications WHERE role_type='Delegator' AND delegation_target=$1",
      [idStr]
    );
    return res.rows.map(r => r.discord_id);
  } catch (e) {
    if (ALERTS_DEBUG) console.warn("[alerts] getDelegatorDiscordIdsByValidator failed:", e?.message || e);
    return [];
  }
}

async function handleDelegatorPaydayAccountReward({
  account,
  transactionFees,
  bakerReward,
  finalizationReward,
  blockHash,
}) {
  if (!account) return;

  const totalCCD = normPaydayCCD(transactionFees)
                 + normPaydayCCD(bakerReward)
                 + normPaydayCCD(finalizationReward);

  if ((Number(totalCCD) || 0) <= 0) {
    if (ALERTS_DEBUG) console.log("[alerts] delegator payday: zero amount, skip", account);
    return;
  }

  const rows = await pool.query(
    "SELECT DISTINCT discord_id, delegation_target FROM verifications WHERE role_type='Delegator' AND wallet_address=$1",
    [String(account)]
  );
  if (rows.rowCount === 0) {
    if (ALERTS_DEBUG) console.log("[alerts] delegator payday: no recipients for", account);
    return;
  }

  const totalStr = fmtCCD(totalCCD);

  for (const r of rows.rows) {
    const mention = `<@${r.discord_id}>`;

    let targetNorm = null;
    const t = (r.delegation_target || "").trim().toLowerCase();
    if (t === "passive") {
      targetNorm = "passive";
    } else if (t) {
      const n = Number(t);
      if (Number.isFinite(n)) targetNorm = String(n);
    }

    await safeDM(
      r.discord_id,
      MSGS.delegatorPaydayReward(mention, totalStr, blockHash, targetNorm)
    );
  }
}

async function notifyStatus(validatorId, status = {}) {
  const idInt = Number(validatorId);
  const idStr = String(validatorId);

  await pool.query(
    "UPDATE verifications SET is_suspended=$2, last_notified_suspended=$2 WHERE role_type='Validator' AND validator_id=$1",
    [idInt, status]
  );
  await pool.query(
    "UPDATE verifications SET last_notified_suspended=$2 WHERE role_type='Delegator' AND delegation_target=$1",
    [idStr, status]
  );

  const owners = await pool.query(
    "SELECT DISTINCT discord_id, wallet_address FROM verifications WHERE role_type='Validator' AND validator_id=$1",
    [idInt]
  );
  const delegators = await pool.query(
    "SELECT DISTINCT discord_id FROM verifications WHERE role_type='Delegator' AND delegation_target=$1",
    [idStr]
  );

  for (const r of owners.rows) {
    const mention = `<@${r.discord_id}>`;
    const wallet = r.wallet_address || "unknown";
    let msg;
    if (status === "suspension_is_pending") {
      msg = MSGS.validatorPendingSuspension(mention, wallet);
    } else if (status === "yes") {
      msg = MSGS.validatorSuspended(mention, wallet);
    } else {
      msg = MSGS.validatorReactivated(mention, wallet);
    }
    await safeDM(r.discord_id, msg);
  }

  for (const r of delegators.rows) {
    const mention = `<@${r.discord_id}>`;
    let msg;
    if (status === "suspension_is_pending") {
      msg = MSGS.delegatorValidatorPendingSuspension(mention, idStr);
    } else if (status === "yes") {
      msg = MSGS.delegatorValidatorSuspended(mention, idStr);
    } else {
      msg = MSGS.delegatorValidatorActive(mention, idStr);
    }
    await safeDM(r.discord_id, msg);
  }
}

// ───────────────────────────────
// Validator self-stake decreased — now uses messages.js template (with ALL cooldowns)
// ───────────────────────────────
async function handleValidatorStakeDecreased({
  validatorId,
  account,
  newStakeMicro,
  txHash,
  blockHash,
  timestampIso,
}) {
  if (!validatorId || !Number.isFinite(Number(newStakeMicro))) return;

  const vidNum = Number(validatorId);
  const vidStr = String(validatorId);

  // Exact stake via CLI; fallback to best-effort conversion
  let stakeCCD = await getSelfStakeCCD_CLI(account);
  if (!Number.isFinite(stakeCCD)) {
    stakeCCD = toCCD_bestEffort(newStakeMicro);
  }
  const newStakeCCD = fmtCCD2(stakeCCD, 2);

  const owners = await pool.query(
    "SELECT DISTINCT discord_id, wallet_address FROM verifications WHERE role_type='Validator' AND validator_id=$1",
    [vidNum]
  );

  const delegators = await pool.query(
    "SELECT DISTINCT discord_id FROM verifications WHERE role_type='Delegator' AND delegation_target=$1",
    [vidStr]
  );

  // Pull ALL active cooldowns for the validator account
  let cooldowns = [];
  try {
    cooldowns = await getCooldowns(account); // [{ amountCCD, when }, ...]
  } catch (_) {
    cooldowns = [];
  }

  // Notify validator owners using centralized template
  for (const r of owners.rows) {
    const uid = r.discord_id;
    const mention = `<@${uid}>`;
    await safeDM(
      uid,
      MSGS.validatorSelfStakeDecreased(
        mention,
        newStakeCCD,
        cooldowns,
        txHash || null,
        blockHash || null,
        timestampIso || null
      )
    );
  }

  // Notify delegators of that validator (message unchanged)
  for (const r of delegators.rows) {
    const uid = r.discord_id;
    const mention = `<@${uid}>`;
    await safeDM(
      uid,
      MSGS.delegatorValidatorSelfStakeDecreased(
        mention,
        vidStr,
        newStakeCCD,
        txHash || null,
        blockHash || null
      )
    );
  }
}

// Broadcast to all verified users (Validators + Delegators)
async function broadcastToAllVerified(payloadBuilder) {
  const resV = await pool.query(
    "SELECT DISTINCT discord_id FROM verifications WHERE role_type='Validator'"
  );
  const resD = await pool.query(
    "SELECT DISTINCT discord_id FROM verifications WHERE role_type='Delegator'"
  );
  const all = new Set([
    ...resV.rows.map(r => r.discord_id),
    ...resD.rows.map(r => r.discord_id),
  ]);
  for (const uid of all) {
    const mention = `<@${uid}>`;
    const msg = payloadBuilder(mention);
    await safeDM(uid, msg);
  }
}

async function handleNetworkValidatorAdded({
  validatorId,
  account,
  stakeMicro,
  openStatus,
  commissions,
  txHash,
  blockHash,
  metadataUrl,
}) {
  const asCCD = (Number(stakeMicro) >= 1e10) ? Number(stakeMicro) / 1e6 : Number(stakeMicro);
  const stakeCCD = fmtCCD2(asCCD, 2);

  await broadcastToAllVerified((mention) =>
    MSGS.networkNewValidator(
      mention,
      String(validatorId),
      account || null,
      stakeCCD,
      openStatus || null,
      {
        baking: typeof commissions?.baking === "number" ? commissions.baking : undefined,
        txFee: typeof commissions?.txFee === "number" ? commissions.txFee : undefined,
      },
      txHash || null,
      blockHash || null,
      metadataUrl || null
    )
  );
}

// Broadcast: a validator was removed from the network (exclude impacted users).
async function handleNetworkValidatorRemoved({
  validatorId,
  account,
  txHash,
  blockHash,
  excludeDiscordIds = [], // NEW: list of user IDs to skip
}) {
  const skip = new Set(excludeDiscordIds.map(String));

  // Also exclude the removed validator's owner(s) from the generic "different validator" message.
  try {
    const owners = await pool.query(
      "SELECT DISTINCT discord_id FROM verifications WHERE role_type='Validator' AND validator_id=$1",
      [Number(validatorId)]
    );
    for (const r of owners.rows) skip.add(String(r.discord_id));
  } catch (e) {
    if (ALERTS_DEBUG) console.warn("[alerts] handleNetworkValidatorRemoved owners lookup failed:", e?.message || e);
  }

  // Collect all verified users (validators + delegators), then filter out skip set.
  let recipients = [];
  try {
    const v = await pool.query("SELECT DISTINCT discord_id FROM verifications WHERE role_type='Validator'");
    const d = await pool.query("SELECT DISTINCT discord_id FROM verifications WHERE role_type='Delegator'");
    recipients = [...new Set([...v.rows, ...d.rows].map(r => String(r.discord_id)))].filter(id => !skip.has(id));
  } catch (e) {
    if (ALERTS_DEBUG) console.warn("[alerts] handleNetworkValidatorRemoved recipients query failed:", e?.message || e);
    return;
  }

  if (recipients.length === 0) return;

  for (const uid of recipients) {
    const mention = `<@${uid}>`;
    try {
      await safeDM(uid, MSGS.networkValidatorRemoved(mention, String(validatorId), account || null, txHash || null, blockHash || null));
    } catch (e) {
      if (ALERTS_DEBUG) console.warn("[alerts] DM networkValidatorRemoved failed:", e?.message || e);
    }
  }
}

// ───────────────────────────────
// Validator self-stake increased — using message templates from MSGS
// ───────────────────────────────
async function handleValidatorStakeIncreased({
  validatorId, account, newStakeMicro, txHash, blockHash, timestampIso
}) {
  if (!validatorId || !Number.isFinite(Number(newStakeMicro))) return;

  const vidNum = Number(validatorId);
  const vidStr = String(validatorId);

  const owners = await pool.query(
    "SELECT DISTINCT discord_id, wallet_address FROM verifications WHERE role_type='Validator' AND validator_id=$1",
    [vidNum]
  );

  const delegators = await pool.query(
    "SELECT DISTINCT discord_id FROM verifications WHERE role_type='Delegator' AND delegation_target=$1",
    [vidStr]
  );

  // Exact stake via CLI; fallback to best-effort conversion
  let stakeCCD = await getSelfStakeCCD_CLI(account);
  if (!Number.isFinite(stakeCCD)) {
    stakeCCD = toCCD_bestEffort(newStakeMicro);
  }
  const newStakeCCD = fmtCCD2(stakeCCD, 2);

  // Validator owners
  for (const r of owners.rows) {
    const uid = r.discord_id;
    const mention = `<@${uid}>`;
    await safeDM(
      uid,
      MSGS.validatorSelfStakeIncreased(
        mention,
        newStakeCCD,
        null,
        null,
        txHash || null,
        blockHash || null
      )
    );
  }

  // Delegators of that validator
  for (const r of delegators.rows) {
    const uid = r.discord_id;
    const mention = `<@${uid}>`;
    await safeDM(
      uid,
      MSGS.delegatorValidatorSelfStakeIncreased(
        mention,
        vidStr,
        newStakeCCD,
        null,
        txHash || null,
        blockHash || null
      )
    );
  }
}

async function handleDelegatorStakeIncreased({ account, newStakeMicro, txHash, blockHash }) {
  if (!account || !Number.isFinite(Number(newStakeMicro))) return;

  const res = await pool.query(
    "SELECT DISTINCT discord_id FROM verifications WHERE role_type='Delegator' AND wallet_address=$1",
    [String(account)]
  );
  if (res.rowCount === 0) {
    if (ALERTS_DEBUG) console.log("[alerts] stake increased: no recipients for", account);
    return;
  }

  let stakeCCD = await getDelegatedStakeCCD_CLI(account);
  if (!Number.isFinite(stakeCCD)) {
    const n = Number(newStakeMicro);
    if (Number.isFinite(n)) stakeCCD = n >= 1e6 ? n / 1e6 : n;
  }
  const stakeStr = fmtCCD2(stakeCCD, 2);

  for (const row of res.rows) {
    const uid = row.discord_id;
    const mention = `<@${uid}>`;
    await safeDM(uid, MSGS.delegatorStakeIncreased(mention, stakeStr, txHash || null, blockHash || null));
  }
}

async function handleDelegatorStakeDecreased({ account, newStakeMicro, txHash, blockHash, timestampIso }) {
  if (!account || !Number.isFinite(Number(newStakeMicro))) return;

  const res = await pool.query(
    "SELECT DISTINCT discord_id FROM verifications WHERE role_type='Delegator' AND wallet_address=$1",
    [String(account)]
  );
  if (res.rowCount === 0) {
    if (ALERTS_DEBUG) console.log("[alerts] stake decreased: no recipients for", account);
    return;
  }

  let currentStakeCCD = await getDelegatedStakeCCD_CLI(account);
  if (!Number.isFinite(currentStakeCCD)) {
    const n = Number(newStakeMicro);
    currentStakeCCD = Number.isFinite(n) ? (n >= 1e6 ? n / 1e6 : n) : null;
  }
  const stakeStr = Number.isFinite(currentStakeCCD) ? fmtCCD2(currentStakeCCD, 2)
                                                    : fmtCCD2(Number(newStakeMicro) / 1e6, 2);

  let cooldowns = [];
  try {
    cooldowns = await getCooldowns(account);
  } catch (_) {
    cooldowns = [];
  }

  for (const row of res.rows) {
    const uid = row.discord_id;
    const mention = `<@${uid}>`;

    const parts = [];
    parts.push("🔽 **Stake decreased!**");
    parts.push(`Your new delegation stake is **${stakeStr} CCD**.`);

    if (Array.isArray(cooldowns) && cooldowns.length) {
      parts.push("⏳ Inactive stake in cooldown:");
      for (const c of cooldowns) {
        parts.push(`• **${c.amountCCD} CCD** — available after **${c.when}**.`);
      }
    }

    if (txHash)   parts.push(`Tx: ${scanTxLink(txHash)}`);
    if (blockHash) parts.push(`Block: ${scanBlockLink(blockHash)}`);

    try {
      await safeDM(uid, { content: mention, embeds: [{ description: parts.join("\n") }] });
    } catch (e) {
      if (ALERTS_DEBUG) console.warn("[alerts] delegatorStakeDecreased DM failed:", e?.message || e);
    }
  }

  const belowMin =
    Number.isFinite(currentStakeCCD) ? (currentStakeCCD < MIN_DELEGATION_CCD)
                                     : (Number(newStakeMicro) < (MIN_DELEGATION_CCD * 1e6));
  if (!belowMin) return;

  let guild = null;
  if (discordClient && DISCORD_GUILD_ID) {
    try { guild = await discordClient.guilds.fetch(DISCORD_GUILD_ID); } catch {}
  }

  for (const row of res.rows) {
    const uid = row.discord_id;
    const mention = `<@${uid}>`;

    if (guild && DELEGATOR_ROLE_ID) {
      try {
        const member = await guild.members.fetch(uid);
        if (member?.roles?.cache?.has(DELEGATOR_ROLE_ID)) {
          await member.roles.remove(DELEGATOR_ROLE_ID, "Delegation below minimum threshold");
        }
      } catch (e) {
        if (ALERTS_DEBUG) console.warn(`[alerts] remove Delegator role failed for ${uid}:`, e?.message || e);
      }
    }

    try {
      await pool.query(
        "DELETE FROM verifications WHERE role_type='Delegator' AND wallet_address=$1 AND discord_id=$2",
        [String(account), String(uid)]
      );
    } catch (e) {
      if (ALERTS_DEBUG) console.warn("[alerts] delete verification row failed:", e?.message || e);
    }

    try {
      const nowStakeForMsg = Number.isFinite(currentStakeCCD) ? currentStakeCCD : (Number(newStakeMicro) / 1e6);
      await safeDM(
        uid,
        MSGS.delegatorRoleRevokedBelowMinimum(
          mention,
          account,
          MIN_DELEGATION_CCD,
          nowStakeForMsg,
          txHash || null,
          blockHash || null
        )
      );
    } catch (e) {
      if (ALERTS_DEBUG) console.warn("[alerts] delegatorRoleRevokedBelowMinimum DM failed:", e?.message || e);
    }

    const stakeStrForLog = (Number.isFinite(currentStakeCCD) ? currentStakeCCD : (Number(newStakeMicro) / 1e6))
      .toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    await sendModLog(
      `🛑 Removed role **Delegator** from <@${uid}> — stake ${stakeStrForLog} CCD < min ${MIN_DELEGATION_CCD.toLocaleString("en-US")} CCD`
    );
  }
}

const newDelegatorBuckets = new Map();
const NEW_DELEGATOR_AGG_WINDOW_MS = 800;

function bucketKeyForNewDelegator({ txHash, delegatorId }) {
  return txHash ? `tx:${txHash}` : `dg:${delegatorId}`;
}

function getOrMakeNewDelegatorBucket(key) {
  let b = newDelegatorBuckets.get(key);
  if (!b) {
    b = {
      sawAdded: false,
      delegatorId: null,
      account: null,
      validatorId: null,
      stakeMicro: null,
      txHash: null,
      timer: null
    };
    newDelegatorBuckets.set(key, b);
  }
  return b;
}

async function handleDelegatorStakeChangedForValidator({
  validatorId,
  delegatorId,
  account,
  direction,
  newStakeMicro,
  txHash,
  timestampIso,
}) {
  const vidNum = Number(validatorId);
  if (!Number.isFinite(vidNum)) return;

  const owners = await pool.query(
    "SELECT DISTINCT discord_id FROM verifications WHERE role_type='Validator' AND validator_id=$1",
    [vidNum]
  );
  if (owners.rowCount === 0) return;

  let stakeCCD = null;
  try {
    const CLIENT_PATH = process.env.CONCORDIUM_CLIENT_PATH || "concordium-client";
    const GRPC_IP     = process.env.GRPC_IP || "127.0.0.1";
    const GRPC_PORT   = String(process.env.GRPC_PORT || 20000);
    const USE_TLS     = (process.env.GRPC_TLS || "").toLowerCase() === "true" || process.env.GRPC_TLS === "1";

    const args = ["account", "show", String(account), "--grpc-ip", GRPC_IP, "--grpc-port", GRPC_PORT];
    if (USE_TLS) args.push("--secure");

    const { execFile } = require("child_process");
    const stdout = await new Promise((resolve, reject) => {
      execFile(CLIENT_PATH, args, { maxBuffer: 1024 * 1024 }, (err, out) => {
        if (err) return reject(err);
        resolve(String(out));
      });
    });

    const m = stdout.match(/Staked amount:\s*([0-9][0-9.,]*)\s*CCD/i);
    if (m) stakeCCD = Number(m[1].replace(/,/g, ""));
  } catch (e) {
    if (ALERTS_DEBUG) console.warn("[alerts] stake fetch via CLI failed:", e?.message || e);
  }

  if (stakeCCD == null) {
    const n = Number(newStakeMicro);
    if (Number.isFinite(n)) {
      stakeCCD = n >= 1e6 ? n / 1e6 : n;
    }
  }

  for (const row of owners.rows) {
    const uid = row.discord_id;
    const mention = `<@${uid}>`;
    const msg = MSGS.delegatorStakeChangedForValidator(
      mention,
      String(vidNum),
      account || "unknown",
      String(delegatorId),
      direction === "increased" ? "increased" : "decreased",
      stakeCCD != null ? stakeCCD : "unknown",
      timestampIso || null,
      txHash || null
    );
    try {
      await safeDM(uid, msg);
    } catch (e) {
      if (ALERTS_DEBUG) console.warn("[alerts] DM to validator failed:", e?.message || e);
    }
  }
}

async function flushNewDelegatorBucket(key) {
  const b = newDelegatorBuckets.get(key);
  if (!b) return;
  newDelegatorBuckets.delete(key);

  if (!b.sawAdded || !b.validatorId || !b.account || !Number.isFinite(Number(b.stakeMicro))) {
    return;
  }

  const poolId = Number(b.validatorId);
  if (!Number.isFinite(poolId)) return;

  const owners = await pool.query(
    "SELECT DISTINCT discord_id FROM verifications WHERE role_type='Validator' AND validator_id=$1",
    [poolId]
  );
  if (owners.rowCount === 0) return;

  const stakeMicro = Number(b.stakeMicro);
  const txHash = b.txHash || null;

  for (const row of owners.rows) {
    const uid = row.discord_id;
    const mention = `<@${uid}>`;
    await safeDM(
      uid,
      MSGS.newDelegatorJoined(mention, String(poolId), b.account, stakeMicro, txHash)
    );
  }
}

async function handleNewDelegator_DelegationAdded({ delegatorId, account, txHash }) {
  const key = bucketKeyForNewDelegator({ txHash, delegatorId });
  const b = getOrMakeNewDelegatorBucket(key);
  b.sawAdded = true;
  b.delegatorId = String(delegatorId);
  b.account = String(account);
  if (txHash) b.txHash = String(txHash);
  if (!b.timer) {
    b.timer = setTimeout(() => flushNewDelegatorBucket(key), NEW_DELEGATOR_AGG_WINDOW_MS);
    if (typeof b.timer.unref === "function") b.timer.unref();
  }
}

async function handleNewDelegator_TargetSet({ delegatorId, bakerId, txHash }) {
  const key = bucketKeyForNewDelegator({ txHash, delegatorId });
  const b = getOrMakeNewDelegatorBucket(key);
  b.delegatorId = String(delegatorId);
  b.validatorId = String(bakerId);
  if (txHash) b.txHash = String(txHash);
  if (!b.timer) {
    b.timer = setTimeout(() => flushNewDelegatorBucket(key), NEW_DELEGATOR_AGG_WINDOW_MS);
    if (typeof b.timer.unref === "function") b.timer.unref();
  }
}

async function handleNewDelegator_StakeIncreased({ delegatorId, newStakeMicro, txHash }) {
  const key = bucketKeyForNewDelegator({ txHash, delegatorId });
  const b = getOrMakeNewDelegatorBucket(key);
  b.delegatorId = String(delegatorId);
  b.stakeMicro = Number(newStakeMicro);
  if (txHash) b.txHash = String(txHash);
  if (!b.timer) {
    b.timer = setTimeout(() => flushNewDelegatorBucket(key), NEW_DELEGATOR_AGG_WINDOW_MS);
    if (typeof b.timer.unref === "function") b.timer.unref();
  }
}

async function handleValidatorPrimed({ validatorId, blockHash }) {
  if (!validatorId) return;
  await notifyStatus(validatorId, "suspension_is_pending", { blockHash });
}

async function handleValidatorSuspended({ validatorId, blockHash }) {
  if (!validatorId) return;
  await notifyStatus(validatorId, "yes", { blockHash });
}

async function handleValidatorResumed({ validatorId, blockHash, txHash }) {
  if (!validatorId) return;
  await notifyStatus(validatorId, "no", { blockHash, txHash });
}

module.exports = {
  setAlertsClient,
  handleCommissionUpdate,
  handleValidatorPrimed,
  handleValidatorSuspended,
  handleValidatorResumed,
  handleDelegationTargetChanged,
  handleValidatorRemoved,
  handleValidatorPaydayAccountReward,
  handleDelegatorPaydayAccountReward,
  handleDelegatorStakeIncreased,
  handleDelegatorStakeDecreased,
  handleNewDelegator_DelegationAdded,
  handleNewDelegator_TargetSet,
  handleNewDelegator_StakeIncreased,
  handleDelegatorLeftPool,
  handleDelegatorJoinedPool,
  handleDelegatorStakeChangedForValidator,
  handleValidatorStakeIncreased,
  handleValidatorStakeDecreased,
  handleNetworkValidatorAdded,
  handleNetworkValidatorRemoved,
  getDelegatorDiscordIdsByValidator,
};