// modules/roleReconciler.js
/**
 * Reconciles Discord roles & DB state after downtime via /reconcile_roles:
 * - Delegators:
 *    • if no longer delegating -> remove Discord role, (optionally) delete row from verifications, DM user, log to mod_logs
 *    • if delegating to a different target -> UPDATE verifications.delegation_target (no notifications here)
 *      and refresh validator_delegators for old/new pools (if module present)
 * - Validators:
 *    • if no longer validator -> remove Discord role, cleanup validator_* tables,
 *      (optionally) delete verifications row, DM user, log to mod_logs
 */

const { Pool } = require('pg');
const { runCommandWithRetry } = require('../utils/retry');

const {
  PG_USER, PG_HOST, PG_DATABASE, PG_PASSWORD, PG_PORT,
  DISCORD_GUILD_ID, VALIDATOR_ROLE_ID, DELEGATOR_ROLE_ID, MOD_LOGS_CHANNEL_ID,
  CONCORDIUM_CLIENT_PATH, GRPC_IP, GRPC_PORT, GRPC_TLS,
} = process.env;

// ---------- DB pool ----------
const pool = new Pool({
  user: PG_USER,
  host: PG_HOST,
  database: PG_DATABASE,
  password: PG_PASSWORD,
  port: PG_PORT,
  keepAlive: true,
});
pool.on('error', (e) => console.error('[db] idle client error', e));

// ---------- Concordium CLI helpers ----------
const CLIENT_PATH = CONCORDIUM_CLIENT_PATH || 'concordium-client';
const HOST = GRPC_IP || '127.0.0.1';
const PORT = Number(GRPC_PORT || 20000);
const USE_TLS = String(GRPC_TLS || '').toLowerCase() === 'true' || GRPC_TLS === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => (s == null ? null : String(s).trim());
const toNum = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

function buildCli(args) {
  const flags = [`--grpc-ip ${HOST}`, `--grpc-port ${PORT}`];
  if (USE_TLS) flags.push('--secure');
  return `${CLIENT_PATH} ${args.join(' ')} ${flags.join(' ')}`;
}
async function execCli(args) {
  const cmd = buildCli(args);
  const out = await runCommandWithRetry(cmd);
  return String(out || '');
}

// ---------- Parsers ----------
function parseDelegationFromAccountShow(out) {
  const s = String(out || '');
  const mDeleg = s.match(/\bDelegating\s+stake\s*:\s*(yes|no)\b/i);
  const isDelegating = mDeleg ? /yes/i.test(mDeleg[1]) : null;

  let target = null;
  const mTargetLine = s.match(/\bDelegation\s+target\s*:\s*([^\n\r]+)/i);
  if (mTargetLine) {
    const tail = mTargetLine[1].trim();
    if (/passive/i.test(tail)) target = 'passive';
    else {
      const mId = tail.match(/(\d{1,12})/);
      if (mId) target = String(Number(mId[1]));
    }
  }
  return { isDelegating, target };
}

function parseValidatorFromAccountShow(out) {
  const s = String(out || '');
  const mNew = s.match(/^\s*Validator\s*:\s*#\s*(\d{1,12})\b/im);
  if (mNew) return Number(mNew[1]);
  const mId = s.match(/\b(Baker\s*ID|BakerId|Pool\s*owner\s*ID)\s*:\s*(\d{1,12})\b/i);
  return mId ? Number(mId[2]) : null;
}

async function isStillValidator(validatorId, wallet) {
  try {
    await execCli(['pool', 'status', String(validatorId)]);
    return true;
  } catch {
    try {
      const out = await execCli(['account', 'show', String(wallet)]);
      const vid = parseValidatorFromAccountShow(out);
      return Number.isFinite(vid);
    } catch {
      return false;
    }
  }
}

// ---------- Mod-log / DM helpers ----------
const short = (s) => (s ? `${String(s).slice(0, 6)}…${String(s).slice(-4)}` : '');
async function notifyModLog(client, content) {
  if (!MOD_LOGS_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(MOD_LOGS_CHANNEL_ID);
    if (ch?.isTextBased?.()) await ch.send(content);
  } catch (e) {
    console.warn('[reconcile] modlog send warn:', e?.message || e);
  }
}

async function safeDM(member, text) {
  try { await member.send(text); } catch { }
}

// ---------- Delegators ----------
async function reconcileDelegators(client, { deleteRows = true, debug = false } = {}) {
  const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
  const roleId = DELEGATOR_ROLE_ID;

  let vdel = null;
  try { vdel = require('../modules/validatorDelegators'); } catch {}

  const { rows } = await pool.query(`
    SELECT id, discord_id, wallet_address, delegation_target
      FROM verifications
     WHERE role_type = 'Delegator'
       AND discord_id IS NOT NULL
  `);

  for (const r of rows) {
    const did = strip(r.discord_id);
    const addr = strip(r.wallet_address);
    const dbTarget = strip(r.delegation_target);
    if (!did || !addr) continue;

    let parsed;
    try {
      const out = await execCli(['account', 'show', addr]);
      parsed = parseDelegationFromAccountShow(out);
    } catch (e) {
      if (debug) console.warn(`[reconcile] account show failed for ${addr}: ${e?.message || e}`);
      continue;
    }

    const nowDelegating = parsed.isDelegating === true;
    const chainTarget = parsed.target; // 'passive' | '<vid>' | null

    if (!nowDelegating) {
      try {
        const member = await guild.members.fetch(did).catch(() => null);
        if (member?.roles.cache.has(roleId)) {
          await member.roles.remove(roleId, 'Stopped delegating (reconcile)');
          if (debug) console.log(`[reconcile] delegator role removed for ${did}`);
          await safeDM(member,
            `Hi! Your **Delegator** role on **${guild.name}** was removed because you no longer delegate on-chain.
If this was a mistake, please re-delegate and re-verify.`);
          await notifyModLog(client, `🧹 Removed **Delegator** from <@${did}> (addr \`${short(addr)}\`) — stopped delegating (reconcile).`);
          await sleep(200);
        }
      } catch (e) {
        if (debug) console.warn(`[reconcile] remove delegator role warn ${did}: ${e?.message || e}`);
      }

      try {
        if (deleteRows) {
          await pool.query('DELETE FROM verifications WHERE id = $1', [r.id]);
          if (debug) console.log(`[reconcile] delegator row deleted id=${r.id}`);
        } else {
          await pool.query('UPDATE verifications SET delegation_target = NULL WHERE id = $1', [r.id]);
          if (debug) console.log(`[reconcile] delegator target nulled id=${r.id}`);
        }
      } catch (e) {
        if (debug) console.warn(`[reconcile] delete/update delegator row warn id=${r.id}: ${e?.message || e}`);
      }

      const oldVid = toNum(dbTarget);
      if (vdel && oldVid != null) {
        try { await vdel.refreshValidatorDelegators(oldVid); } catch {}
      }
      continue;
    }

    if (chainTarget && chainTarget !== dbTarget) {
      try {
        await pool.query('UPDATE verifications SET delegation_target = $2 WHERE id = $1', [r.id, chainTarget]);
        if (debug) console.log(`[reconcile] delegation_target updated id=${r.id}: ${dbTarget ?? 'NULL'} -> ${chainTarget}`);
      } catch (e) {
        if (debug) console.warn(`[reconcile] update target warn id=${r.id}: ${e?.message || e}`);
      }

      const oldVid = toNum(dbTarget);
      const newVid = toNum(chainTarget);
      if (vdel) {
        try { if (oldVid != null) await vdel.refreshValidatorDelegators(oldVid); } catch {}
        await sleep(150);
        try { if (newVid != null) await vdel.refreshValidatorDelegators(newVid); } catch {}
      }
    }
  }
}

// ---------- Validators ----------
async function reconcileValidators(client, { deleteRows = true, debug = false } = {}) {
  const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
  const roleId = VALIDATOR_ROLE_ID;

  const { rows } = await pool.query(`
    SELECT id, discord_id, wallet_address, validator_id
      FROM verifications
     WHERE role_type = 'Validator'
       AND validator_id IS NOT NULL
       AND discord_id IS NOT NULL
  `);

  for (const r of rows) {
    const did = strip(r.discord_id);
    const addr = strip(r.wallet_address);
    const vid = Number(r.validator_id);
    if (!did || !addr || !Number.isFinite(vid)) continue;

    let still = false;
    try { still = await isStillValidator(vid, addr); }
    catch (e) { if (debug) console.warn(`[reconcile] isStillValidator err vid=${vid}: ${e?.message || e}`); }

    if (still) continue;

    try {
      const member = await guild.members.fetch(did).catch(() => null);
      if (member?.roles.cache.has(roleId)) {
        await member.roles.remove(roleId, 'No longer validator (reconcile)');
        if (debug) console.log(`[reconcile] validator role removed for ${did}`);
        await safeDM(member,
          `Hi! Your **Validator** role on **${guild.name}** was removed because you are no longer a validator on-chain.`);
        await notifyModLog(client, `🧹 Removed **Validator** from <@${did}> (vid \`${vid}\`, addr \`${short(addr)}\`) — no longer validator (reconcile).`);
        await sleep(200);
      }
    } catch (e) {
      if (debug) console.warn(`[reconcile] remove validator role warn ${did}: ${e?.message || e}`);
    }

    try {
      await pool.query('DELETE FROM validator_delegators WHERE validator_id = $1', [vid]);
      if (deleteRows) {
        await pool.query('DELETE FROM verifications WHERE id = $1', [r.id]);
      } else {
        await pool.query('UPDATE verifications SET validator_id = NULL WHERE id = $1', [r.id]);
      }
      if (debug) console.log(`[reconcile] validator cleaned up vid=${vid}, row=${r.id}`);
    } catch (e) {
      if (debug) console.warn(`[reconcile] validator cleanup warn vid=${vid}: ${e?.message || e}`);
    }
  }

  const { rows: rowsNoId } = await pool.query(`
    SELECT id, discord_id, wallet_address
      FROM verifications
     WHERE role_type = 'Validator'
       AND validator_id IS NULL
       AND discord_id IS NOT NULL
  `);

  for (const r of rowsNoId) {
    const did = strip(r.discord_id);
    const addr = strip(r.wallet_address);
    if (!did || !addr) continue;

    let acctOut;
    try {
      acctOut = await execCli(['account', 'show', addr]);
    } catch (e) {
      if (debug) console.warn(`[reconcile] account show failed for ${addr}: ${e?.message || e}`);
      continue;
    }

    const parsedVid = parseValidatorFromAccountShow(acctOut);

    if (Number.isFinite(parsedVid)) {
      try {
        await pool.query('UPDATE verifications SET validator_id = $2 WHERE id = $1', [r.id, parsedVid]);
        if (debug) console.log(`[reconcile] enriched validator row id=${r.id}: set validator_id=${parsedVid}`);
      } catch (e) {
        if (debug) console.warn(`[reconcile] enrich validator_id warn id=${r.id}: ${e?.message || e}`);
      }
      continue;
    }

    try {
      const member = await guild.members.fetch(did).catch(() => null);
      if (member?.roles.cache.has(roleId)) {
        await member.roles.remove(roleId, 'No longer validator (reconcile, by address)');
        if (debug) console.log(`[reconcile] validator role (by addr) removed for ${did}`);
        await safeDM(member,
          `Hi! Your **Validator** role on **${guild.name}** was removed because you are no longer a validator on-chain.`);
        await notifyModLog(client, `🧹 Removed **Validator** from <@${did}> (addr \`${short(addr)}\`) — no longer validator (reconcile).`);
        await sleep(200);
      }
    } catch (e) {
      if (debug) console.warn(`[reconcile] remove validator role warn ${did}: ${e?.message || e}`);
    }

    try {
      if (deleteRows) {
        await pool.query('DELETE FROM verifications WHERE id = $1', [r.id]);
      } else {
        await pool.query('UPDATE verifications SET validator_id = NULL WHERE id = $1', [r.id]);
      }
      if (debug) console.log(`[reconcile] validator (by addr) cleaned row=${r.id}`);
    } catch (e) {
      if (debug) console.warn(`[reconcile] validator (by addr) cleanup warn row=${r.id}: ${e?.message || e}`);
    }
  }
}

// ---------- Public API ----------
async function reconcileRoles(client, opts = {}) {
  const { debug = false } = opts;
  if (debug) console.log('[reconcile] started');
  await reconcileDelegators(client, opts);
  await reconcileValidators(client, opts);
  if (debug) console.log('[reconcile] finished');
}

module.exports = { reconcileRoles };