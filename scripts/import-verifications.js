/**
 * import-verifications.js — imports v1 CSV data into the v2 `verifications` table.
 * Reads CSV (id,tx_hash,wallet_address,discord_id,role_type,verified_at,github_profile),
 * normalizes role_type, and UPSERTs by `id` (insert or update). Adjusts the
 * `verifications_id_seq` to MAX(id) after import. V2-only fields (is_suspended,
 * delegation_target, validator_id, last_notified_*) are NOT touched here.
 *
 * ENV:
 *  - IMPORT_VERIFICATIONS_CSV: path to CSV (required)
 *  - IMPORT_RUN_ON_EMPTY=1: run only if table is empty (else skip)
 *  - IMPORT_FAIL_ON_ERROR=1: exit non-zero on errors (else warn & continue)
 *  - IMPORT_LOG=1: verbose logging
 *
 * Requires PG_* env for DB connection. Exits 0 on success/skip, 2 on fatal (when FAIL_ON_ERROR=1).
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const {
  PG_USER, PG_HOST, PG_DATABASE, PG_PASSWORD, PG_PORT
} = process.env;

const CSV_PATH = process.env.IMPORT_VERIFICATIONS_CSV;
const ONLY_IF_EMPTY = (process.env.IMPORT_RUN_ON_EMPTY || '') === '1';
const FAIL_ON_ERROR = (process.env.IMPORT_FAIL_ON_ERROR || '') === '1';
const VERBOSE = (process.env.IMPORT_LOG || '') === '1';

if (!CSV_PATH) {
  if (VERBOSE) console.log('[import] no IMPORT_VERIFICATIONS_CSV set, skipping');
  process.exit(0);
}

const pool = new Pool({
  user: PG_USER,
  host: PG_HOST,
  database: PG_DATABASE,
  password: PG_PASSWORD,
  port: PG_PORT,
});

function normalizeRole(role) {
  const r = String(role || '').trim().toLowerCase();
  if (r === 'validator') return 'Validator';
  if (r === 'delegator') return 'Delegator';
  if (r === 'developer') return 'Developer';
  return role || null;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') {
        cur += '"'; i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]).map(s => s.trim());

  const need = ['id','tx_hash','wallet_address','discord_id','role_type','verified_at','github_profile'];
  for (const col of need) {
    if (!header.includes(col)) {
      throw new Error(`CSV missing column "${col}" in header`);
    }
  }
  const idx = name => header.indexOf(name);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i]);
    if (parts.length < header.length) continue;
    const row = {
      id:               parts[idx('id')]               ?? '',
      tx_hash:          parts[idx('tx_hash')]          ?? '',
      wallet_address:   parts[idx('wallet_address')]   ?? '',
      discord_id:       parts[idx('discord_id')]       ?? '',
      role_type:        parts[idx('role_type')]        ?? '',
      verified_at:      parts[idx('verified_at')]      ?? '',
      github_profile:   parts[idx('github_profile')]   ?? '',
      _line: i + 1,
    };
    rows.push(row);
  }
  return rows;
}

async function tableExists(client) {
  const q = await client.query(`SELECT to_regclass('public.verifications') AS t`);
  return !!q.rows?.[0]?.t;
}

async function isEmpty(client) {
  const q = await client.query('SELECT COUNT(*)::int AS n FROM verifications');
  return (q.rows?.[0]?.n || 0) === 0;
}

(async () => {
  const abs = path.resolve(CSV_PATH);
  if (!fs.existsSync(abs)) {
    const msg = `[import] CSV not found: ${abs}`;
    if (FAIL_ON_ERROR) {
      console.error(msg);
      process.exit(2);
    } else {
      console.warn(msg, '(continuing)');
      process.exit(0);
    }
  }

  const client = await pool.connect();
  try {
    if (!(await tableExists(client))) {
      const msg = `[import] table "verifications" does not exist. Run migrations first.`;
      if (FAIL_ON_ERROR) {
        console.error(msg);
        process.exit(2);
      } else {
        console.warn(msg, '(continuing)');
        process.exit(0);
      }
    }

    if (ONLY_IF_EMPTY && !(await isEmpty(client))) {
      if (VERBOSE) console.log('[import] verifications is not empty — skipping (IMPORT_RUN_ON_EMPTY=1)');
      process.exit(0);
    }

    const text = fs.readFileSync(abs, 'utf8');
    const rows = parseCsv(text);
    if (!rows.length) {
      if (VERBOSE) console.log('[import] CSV is empty — nothing to import');
      process.exit(0);
    }

    await client.query('BEGIN');

    let inserted = 0, updated = 0, skipped = 0;
    for (const r of rows) {
      const idNum = r.id ? Number(r.id) : null;
      if (!Number.isFinite(idNum)) {
        skipped++;
        if (VERBOSE) console.warn(`[import] skip line ${r._line}: invalid id "${r.id}"`);
        continue;
      }
      const role = normalizeRole(r.role_type);

      const upd = await client.query(
        `UPDATE verifications
           SET tx_hash=$2, wallet_address=$3, discord_id=$4, role_type=$5, verified_at=$6, github_profile=$7
         WHERE id=$1`,
        [
          idNum,
          r.tx_hash || null,
          r.wallet_address || null,
          r.discord_id || null,
          role,
          r.verified_at || null,
          r.github_profile || null,
        ]
      );

      if (upd.rowCount === 0) {
        await client.query(
          `INSERT INTO verifications
             (id, tx_hash, wallet_address, discord_id, role_type, verified_at, github_profile)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO UPDATE SET
             tx_hash=EXCLUDED.tx_hash,
             wallet_address=EXCLUDED.wallet_address,
             discord_id=EXCLUDED.discord_id,
             role_type=EXCLUDED.role_type,
             verified_at=EXCLUDED.verified_at,
             github_profile=EXCLUDED.github_profile`,
          [
            idNum,
            r.tx_hash || null,
            r.wallet_address || null,
            r.discord_id || null,
            role,
            r.verified_at || null,
            r.github_profile || null,
          ]
        );
        inserted++;
      } else {
        updated++;
      }
    }

    await client.query(`
      DO $$
      BEGIN
        PERFORM pg_get_serial_sequence('verifications','id');
        IF FOUND THEN
          PERFORM setval(
            pg_get_serial_sequence('verifications','id'),
            GREATEST((SELECT COALESCE(MAX(id),0) FROM verifications), 1)
          );
        END IF;
      END$$;
    `);

    await client.query('COMMIT');
    console.log(`[import] done: inserted=${inserted}, updated=${updated}, skipped=${skipped} from ${abs}`);
    process.exit(0);
  } catch (e) {
    await client.query('ROLLBACK');
    const msg = `[import] failed: ${e?.message || e}`;
    if (FAIL_ON_ERROR) {
      console.error(msg);
      process.exit(2);
    } else {
      console.warn(msg, '(continuing)');
      process.exit(0);
    }
  } finally {
    client.release();
    await pool.end();
  }
})();