/**
 * backfill.js — seeds and enriches the v2 DB from on-chain data.
 * Uses `concordium-client` via retry (runCommandWithRetry) and throttles calls with BACKFILL_GRPC_DELAY_MS.
 * ENV: IMPORT_VERIFICATIONS_CSV, IMPORT_RUN_ON_EMPTY, CONCORDIUM_CLIENT_PATH, GRPC_IP/PORT/TLS.
 * Idempotent: fills only missing fields and upserts commissions; avoids overwriting existing non-NULL values.
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { Pool } = require("pg");
const { runCommandWithRetry, delay } = require("../utils/retry");

const {
  PG_USER, PG_HOST, PG_DATABASE, PG_PASSWORD, PG_PORT,
  GRPC_IP, GRPC_PORT, GRPC_TLS,
  CONCORDIUM_CLIENT_PATH,
} = process.env;

const SLEEP = Number(process.env.BACKFILL_GRPC_DELAY_MS || 3000);

const pool = new Pool({
  user: PG_USER,
  host: PG_HOST,
  database: PG_DATABASE,
  password: PG_PASSWORD,
  port: PG_PORT,
});

const CLIENT_PATH = CONCORDIUM_CLIENT_PATH || "concordium-client";
const HOST = GRPC_IP || "127.0.0.1";
const PORT = Number(GRPC_PORT || 20000);
const USE_TLS = String(GRPC_TLS || "").toLowerCase() === "true" || GRPC_TLS === "1";

function buildCliCmd(argsArray) {
  const flags = [`--grpc-ip ${HOST}`, `--grpc-port ${PORT}`];
  if (USE_TLS) flags.push("--secure");
  return `${CLIENT_PATH} ${argsArray.join(" ")} ${flags.join(" ")}`;
}

async function execCli(argsArray) {
  const cmd = buildCliCmd(argsArray);
  const out = await runCommandWithRetry(cmd);
  return String(out || "");
}

function cleanAddr(s) {
  if (s == null) return null;
  return String(s)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^[^1-9A-HJ-NP-Za-km-z]+/, "")
    .replace(/[^1-9A-HJ-NP-Za-km-z]+$/, "");
}

function isProbablyAccountAddress(a) {
  return /^[1-9A-HJ-NP-Za-km-z]{40,70}$/.test(String(a || ""));
}

const toNum = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

function parseValidatorFromAccountShow(out) {
  const s = String(out);

  const mNew = s.match(/^\s*Validator\s*:\s*#\s*(\d{1,12})\b/im);
  let validatorId = mNew ? Number(mNew[1]) : null;

  if (validatorId == null) {
    const mId = s.match(/\b(Baker\s*ID|BakerId|Pool\s*owner\s*ID)\s*:\s*(\d{1,12})\b/i);
    if (mId) validatorId = Number(mId[2]);
  }

  let isSuspended = null;
  const mSusp1 = s.match(/\bSuspended\s*:\s*(yes|no|true|false)\b/i);
  if (mSusp1) {
    isSuspended = /yes|true/i.test(mSusp1[1]) ? "yes" : "no";
  } else {
    const mSusp2 = s.match(/\b(Baker|Pool)\s*status\s*:\s*(active|suspended)\b/i);
    if (mSusp2) isSuspended = /suspended/i.test(mSusp2[2]) ? "yes" : "no";
  }

  return { validatorId, isSuspended };
}

function parseDelegationTargetFromAccountShow(out) {
  const s = String(out);
  const mDelegating = s.match(/\bDelegating\s+stake\s*:\s*(yes|no)\b/i);
  if (mDelegating && /no/i.test(mDelegating[1])) return null;

  const mTargetLine = s.match(/\bDelegation\s+target\s*:\s*([^\n\r]+)/i);
  if (!mTargetLine) return null;

  const tail = mTargetLine[1].trim();
  if (/passive/i.test(tail)) return "passive";
  const mId = tail.match(/(\d{1,12})/);
  return mId ? String(Number(mId[1])) : null;
}

function parsePoolStatusExtra(out) {
  const s = String(out);

  function parseCommissionValue(raw) {
    if (!raw) return null;
    const str = String(raw).trim();

    const m = str.match(/([-+]?\d+(?:[.,]\d+)?(?:e[-+]?\d+)?)/i);
    if (!m) return null;

    let v = Number(m[1].replace(",", "."));
    if (!Number.isFinite(v)) return null;

    if (/[％%]/.test(str)) v = v / 100;

    if (v > 1 && v <= 100 && !/[％%]/.test(str)) v = v / 100;

    if (v < 0) v = 0;
    if (v > 1) v = 1;

    return v;
  }

  const mB = s.match(/^\s*(?:-\s*)?(?:Baking|Block\s+commission)\s*:\s*([^\n\r]+)/mi);
  const mT = s.match(/^\s*(?:-\s*)?(?:Transaction\s+fees?|Transaction\s+commission)\s*:\s*([^\n\r]+)/mi);

  const baking = parseCommissionValue(mB && mB[1]);
  const txFee  = parseCommissionValue(mT && mT[1]);

  let isSuspended = null;
  const mSusp1 = s.match(/\bSuspended\s*:\s*(yes|no|true|false)\b/i);
  if (mSusp1) {
    isSuspended = /yes|true/i.test(mSusp1[1]) ? "yes" : "no";
  } else {
    const mSusp2 = s.match(/\b(?:Status|Pool\s*status|Baker\s*status)\s*:\s*(active|suspended)\b/i);
    if (mSusp2) isSuspended = /suspended/i.test(mSusp2[1]) ? "yes" : "no";
  }

  return { baking, txFee, isSuspended };
}

async function runBackfillFromCsv(opts) {
  let csvPath, runOnEmpty = true, debug = false;

  if (typeof opts === "string") {
    csvPath = opts;
  } else {
    const o = opts || {};
    csvPath = o.csvPath ?? process.env.IMPORT_VERIFICATIONS_CSV;
    if (typeof o.runOnEmpty !== "undefined") runOnEmpty = !!o.runOnEmpty;
    if (typeof o.debug !== "undefined") debug = !!o.debug;
    if (typeof o.runOnEmpty === "undefined" && typeof process.env.IMPORT_RUN_ON_EMPTY !== "undefined") {
      runOnEmpty = String(process.env.IMPORT_RUN_ON_EMPTY).trim() === "1";
    }
  }

  if (!csvPath) {
    console.log("[bot] ⚠️ Backfill skipped: IMPORT_VERIFICATIONS_CSV is empty");
    return;
  }

  const abs = path.resolve(csvPath);
  if (!fs.existsSync(abs)) {
    console.log(`[bot] ⚠️ Backfill skipped: CSV not found at ${abs}`);
    return;
  }

  console.log(`📥 Backfill: importing verifications from CSV: ${abs} (runOnEmpty=${runOnEmpty ? "true" : "false"})`);

  if (runOnEmpty) {
    const c = await pool.query("SELECT COUNT(*)::int AS n FROM verifications");
    const n = c.rows?.[0]?.n || 0;
    if (n > 0) {
      console.log("[bot] ℹ️ verifications not empty, skipping CSV import");
      return;
    }
  }

  const text = fs.readFileSync(abs, "utf8");
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });

  let inserted = 0, skipped = 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const r of rows) {
      const id = Number(r.id);
      if (!Number.isFinite(id)) { skipped++; continue; }

      const res = await client.query(
        `INSERT INTO verifications (id, tx_hash, wallet_address, discord_id, role_type, verified_at, github_profile)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO NOTHING`,
        [
          id,
          r.tx_hash || null,
          r.wallet_address || null,
          r.discord_id || null,
          r.role_type || null,
          r.verified_at || null,
          r.github_profile || null
        ]
      );

      if (res.rowCount === 1) inserted++; else skipped++;
    }

    await client.query(
      `SELECT setval('verifications_id_seq', COALESCE((SELECT MAX(id) FROM verifications), 1), true)`
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  console.log(`[import] done: inserted=${inserted}, skipped=${skipped} from ${abs}`);
  console.log("✅ Backfill: import completed");
}

async function runPostImportEnrichment({ debug = false } = {}) {
  console.log("🔎 Post-import enrichment started...");

  const vRows = await pool.query(
    `SELECT id, wallet_address
       FROM verifications
      WHERE role_type='Validator'
        AND (validator_id IS NULL OR is_suspended IS NULL)`
  );

  for (const r of vRows.rows) {
    const addr = cleanAddr(r.wallet_address);
    if (!addr || !isProbablyAccountAddress(addr)) {
      if (debug) console.log(`[backfill] skip invalid validator address #${r.id}: "${r.wallet_address}" → "${addr || "<empty>"}"`);
      continue;
    }

    let validatorId = null;
    let isSuspended = null;

    try {
      const out = await execCli(["account", "show", addr]);
      const p = parseValidatorFromAccountShow(out);
      validatorId = p.validatorId;
      isSuspended = p.isSuspended;
      if (debug) console.log(`[backfill] [CLI] validator #${r.id}: vid=${validatorId ?? "—"}, suspended=${isSuspended ?? "—"}`);
    } catch (e) {
      if (debug) console.log(`[backfill] CLI account show failed for ${addr}: ${e?.message || e}`);
    }

    await delay(SLEEP);

    if (validatorId != null || isSuspended != null) {
      await pool.query(
        `UPDATE verifications
            SET validator_id = COALESCE($2, validator_id),
                is_suspended = COALESCE($3, is_suspended)
         WHERE id = $1`,
        [r.id, validatorId, isSuspended]
      );
    } else if (debug) {
      console.log(`[backfill] ! could not derive validator_id/suspended for row #${r.id} (addr="${r.wallet_address}")`);
    }
  }

  const vids = await pool.query(
    `SELECT DISTINCT validator_id
       FROM verifications
      WHERE role_type='Validator' AND validator_id IS NOT NULL`
  );

  for (const row of vids.rows) {
    const vid = toNum(row.validator_id);
    if (!Number.isFinite(vid)) continue;

    try {
      const out = await execCli(["pool", "status", String(vid)]);
      const { baking, txFee, isSuspended } = parsePoolStatusExtra(out || "");

      await delay(SLEEP);

      if (baking != null && txFee != null) {
        await pool.query(
          `INSERT INTO validator_commissions
             (validator_id, baking_rate, transaction_fee_rate, last_checked_at,
              last_notified_baking_rate, last_notified_transaction_fee_rate)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $2, $3)
           ON CONFLICT (validator_id) DO UPDATE
              SET baking_rate = EXCLUDED.baking_rate,
                  transaction_fee_rate = EXCLUDED.transaction_fee_rate,
                  last_checked_at = CURRENT_TIMESTAMP`,
          [vid, baking, txFee]
        );
        if (debug) console.log(`[backfill] ✓ commissions upserted for pool #${vid}: baking=${baking}, txFee=${txFee}`);
      } else if (debug) {
        console.log(`[backfill] ! could not parse commissions for pool #${vid}`);
      }

      if (isSuspended != null) {
        await pool.query(
          `UPDATE verifications
              SET is_suspended = $2
           WHERE role_type='Validator' AND validator_id=$1`,
          [vid, isSuspended]
        );
      }
    } catch (e) {
      if (debug) console.log(`[backfill] pool status failed for #${vid}: ${e?.message || e}`);
    }

    await delay(SLEEP);
    try {
      const vdel = require("../modules/validatorDelegators");
      await vdel.refreshValidatorDelegators(vid);
      if (debug) console.log(`[backfill] ✓ delegators refreshed for pool #${vid}`);
    } catch (e) {
      if (debug) console.log(`[backfill] refresh delegators failed for #${vid}: ${e?.message || e}`);
    }
    await delay(SLEEP);
  }

  const dRows = await pool.query(
    `SELECT id, wallet_address
       FROM verifications
      WHERE role_type='Delegator' AND delegation_target IS NULL`
  );

  for (const r of dRows.rows) {
    const addr = cleanAddr(r.wallet_address);
    if (!addr || !isProbablyAccountAddress(addr)) {
      if (debug) console.log(`[backfill] skip invalid delegator address #${r.id}: "${r.wallet_address}" → "${addr || "<empty>"}"`);
      continue;
    }

    let target = null;

    try {
      const out = await execCli(["account", "show", addr]);
      target = parseDelegationTargetFromAccountShow(out);
      if (debug) console.log(`[backfill] [CLI] delegator #${r.id}: target=${target ?? "—"}`);
    } catch (e) {
      if (debug) console.log(`[backfill] CLI account show failed for ${addr}: ${e?.message || e}`);
    }

    await delay(SLEEP);

    if (target) {
      await pool.query(
        `UPDATE verifications
            SET delegation_target = $2,
                last_notified_delegation_target = $2
         WHERE id = $1`,
        [r.id, target]
      );
    } else if (debug) {
      console.log(`[backfill] ! could not derive delegation_target for row #${r.id} (addr="${r.wallet_address}")`);
    }
  }

  await pool.query(
    `UPDATE verifications
        SET last_notified_suspended = 'no'
      WHERE last_notified_suspended IS NULL
        AND role_type IN ('Validator','Delegator')`
  );

  console.log("✅ Post-import enrichment finished");
}

module.exports = {
  runBackfillFromCsv,
  runPostImportEnrichment,
};