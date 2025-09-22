// modules/validatorDelegators.js
/**
 * Maintains the `validator_delegators` table by syncing on-chain delegators per validator.
 * Responsibilities:
 * - Connects to a Concordium node via @concordium/web-sdk/nodejs (TLS optional; GRPC_IP/PORT/TLS envs).
 * - Fetches current pool delegators (getPoolDelegators + getAccountInfo), normalizes IDs/addresses.
 * - Upserts rows with `first_seen_at` / `last_seen_at` and prunes delegators no longer in the pool.
 * - Helpers:
 *   • setDelegatorActiveForPool: move/update a delegator to a specific validator pool,
 *   • markDelegatorInactiveEverywhere: remove a delegator from all pools,
 *   • getPoolsForDelegator: list pools/accounts for a delegator ID.
 */
const { Pool } = require("pg");

const {
  PG_USER, PG_HOST, PG_DATABASE, PG_PASSWORD, PG_PORT,
  GRPC_IP, GRPC_PORT, GRPC_TLS
} = process.env;

const USE_TLS = (String(GRPC_TLS || "")).toLowerCase() === "true" || GRPC_TLS === "1";
const HOST = GRPC_IP || "127.0.0.1";
const PORT = Number(GRPC_PORT || 20000);

const pool = new Pool({
  user: PG_USER,
  host: PG_HOST,
  database: PG_DATABASE,
  password: PG_PASSWORD,
  port: PG_PORT,
});

let ConcordiumGRPCNodeClient, credentials;
async function getGrpc() {
  if (!ConcordiumGRPCNodeClient) {
    ({ ConcordiumGRPCNodeClient, credentials } = await import("@concordium/web-sdk/nodejs"));
  }
  const creds = USE_TLS ? credentials.createSsl() : credentials.createInsecure();
  return new ConcordiumGRPCNodeClient(HOST, PORT, creds);
}

function stripQuotes(s) {
  if (s == null) return null;
  return String(s).trim().replace(/^["'`]+|["'`]+$/g, "");
}

const toNum = (x) => {
  if (x == null) return null;
  if (typeof x === "number") return x;
  if (typeof x === "bigint") return Number(x);
  if (typeof x === "string") {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof x === "object") {
    for (const k of ["value", "accountIndex", "index"]) {
      if (x[k] != null) return toNum(x[k]);
    }
  }
  return null;
};
const extractAccount = (d) =>
  d?.accountAddress?.address ??
  d?.accountAddress ??
  d?.account ??
  d?.address ??
  d?.owner ??
  null;

async function refreshValidatorDelegators(validatorId) {
  const vid = Number(validatorId);
  if (!Number.isFinite(vid)) return;

  const client = await getGrpc();

  const pairs = [];
  for await (const d of client.getPoolDelegators(vid)) {
    const acc = extractAccount(d);
    if (!acc) continue;

    try {
      const info = await client.getAccountInfo(acc);
      const ai = info?.accountInfo ?? info;
      const delegatorId = toNum(ai?.accountIndex ?? ai?.index ?? ai?.accountIndex?.value);
      if (delegatorId != null) {
        pairs.push({ delegatorId, account: stripQuotes(acc) });
      }
    } catch {
    }
  }

  const currentIds = pairs.map(p => p.delegatorId);

  const pg = await pool.connect();
  try {
    await pg.query("BEGIN");

    await pg.query(
      `DELETE FROM validator_delegators
        WHERE validator_id = $1
          AND NOT (delegator_id = ANY($2::int[]))`,
      [vid, currentIds]
    );

    for (const { delegatorId, account } of pairs) {
      await pg.query(
        `INSERT INTO validator_delegators
           (validator_id, delegator_id, account_address, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (validator_id, delegator_id) DO UPDATE
           SET account_address = EXCLUDED.account_address,
               last_seen_at = NOW()`,
        [vid, delegatorId, account]
      );
    }

    await pg.query("COMMIT");
  } catch (e) {
    await pg.query("ROLLBACK");
    throw e;
  } finally {
    pg.release();
  }
}

async function setDelegatorActiveForPool(delegatorId, account, validatorId) {
  const did = Number(delegatorId);
  const vid = Number(validatorId);
  if (!Number.isFinite(did) || !Number.isFinite(vid)) return;

  const pg = await pool.connect();
  try {
    await pg.query("BEGIN");

    await pg.query(
      "DELETE FROM validator_delegators WHERE delegator_id = $1",
      [did]
    );

    await pg.query(
      `INSERT INTO validator_delegators
         (validator_id, delegator_id, account_address, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (validator_id, delegator_id) DO UPDATE
         SET account_address = EXCLUDED.account_address,
             last_seen_at = NOW()`,
      [vid, did, stripQuotes(String(account))]
    );

    await pg.query("COMMIT");
  } catch (e) {
    await pg.query("ROLLBACK");
    throw e;
  } finally {
    pg.release();
  }
}

async function markDelegatorInactiveEverywhere(delegatorId) {
  const did = Number(delegatorId);
  if (!Number.isFinite(did)) return;
  await pool.query(
    "DELETE FROM validator_delegators WHERE delegator_id = $1",
    [did]
  );
}

async function getPoolsForDelegator(delegatorId) {
  const did = Number(delegatorId);
  if (!Number.isFinite(did)) return [];
  const res = await pool.query(
    "SELECT validator_id, account_address FROM validator_delegators WHERE delegator_id = $1",
    [did]
  );
  return res.rows;
}

module.exports = {
  refreshValidatorDelegators,
  setDelegatorActiveForPool,
  markDelegatorInactiveEverywhere,
  getPoolsForDelegator,
};