// modules/txloggerListener.js
/**
 * High-throughput Concordium gRPC block/tx listener with gap recovery.
 * Responsibilities:
 * - Streams finalized blocks via @concordium/web-sdk; backfills height gaps when missed.
 * - For each tx, extracts sender & MEMO (gRPC first; falls back to `concordium-client transaction status`).
 * - Drives verification “memo waiters”:
 *   • Delegators: registerDelegatorMemoWaiter(...) + wrong-memo & TTL-expiry notifiers.
 *   • Validators:  registerValidatorMemoWaiter(...) + wrong-memo & TTL-expiry notifiers.
 *   (Pruned on a schedule via TXL_WAITER_TTL_MINUTES / TXL_PRUNE_INTERVAL_MS.)
 * - Normalizes hashes/addresses and derives block ISO timestamp for freshness checks.
 * - Fans out on-chain events to the alerts module:
 *   • Delegation add/remove/target change; stake increased/decreased; new delegators; PayDay account rewards.
 *   • Validator commission updates, suspended/resumed/removed, and “primed for suspension” specials.
 *   • Uses validator_delegators mapping to DM validators about join/leave/stake-change events.
 * - Configurable logging/filtering via TXL_* env flags; TLS via GRPC_TLS; CLI path via CONCORDIUM_CLIENT_PATH.
 */
const { execFile } = require("child_process");
let ConcordiumGRPCNodeClient, credentials;
const vdel = require("./validatorDelegators");

const alerts = require("./alerts");
const LOG_TX = (process.env.TXL_LOG_TX || "").toLowerCase() === "true" || process.env.TXL_LOG_TX === "1";
const GRPC_HOST = process.env.GRPC_IP || "127.0.0.1";
const GRPC_PORT = Number(process.env.GRPC_PORT || 20000);
const USE_TLS =
  (process.env.GRPC_TLS || "").toLowerCase() === "true" ||
  process.env.GRPC_TLS === "1";

const LOG_SPECIAL =
  (process.env.TXL_LOG_SPECIAL || "").toLowerCase() === "true" ||
  process.env.TXL_LOG_SPECIAL === "1";
const SPECIAL_TAGS_SET = (() => {
  const raw = (process.env.TXL_SPECIAL_TAGS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return raw.length ? new Set(raw) : null;
})();

const DEBUG =
  (process.env.TXL_DEBUG || "").toLowerCase() === "true" ||
  process.env.TXL_DEBUG === "1";

const LOG_BLOCKS =
  (process.env.TXL_LOG_BLOCKS || "").toLowerCase() === "true" ||
  process.env.TXL_LOG_BLOCKS === "1";

const LOG_TX_EVENTS =
  (process.env.TXL_LOG_TX_EVENTS || "").toLowerCase() === "true" ||
  process.env.TXL_LOG_TX_EVENTS === "1";
const EVENT_TAGS_SET = (() => {
  const raw = (process.env.TXL_EVENT_TAGS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return raw.length ? new Set(raw) : null;
})();

const WAITER_TTL_MIN =
  Number.isFinite(Number(process.env.TXL_WAITER_TTL_MINUTES))
    ? Number(process.env.TXL_WAITER_TTL_MINUTES)
    : 20;
const WAITER_TTL_MS = Math.max(1, WAITER_TTL_MIN) * 60 * 1000;
const PRUNE_INTERVAL_MS = Number(process.env.TXL_PRUNE_INTERVAL_MS || 60 * 1000);

const CLIENT_PATH = process.env.CONCORDIUM_CLIENT_PATH || "concordium-client";

const delegatorWaiters = new Map();
let delegatorWrongMemoNotifier = null;
let delegatorExpiredNotifier = null;

const validatorWaiters = new Map();
let validatorWrongMemoNotifier = null;
let validatorExpiredNotifier = null;

function normAddr(a) {
  if (!a) return "";
  return String(a).trim().toLowerCase();
}
function normMemo(s) {
  if (!s) return "";
  try { s = String(s).normalize("NFKC"); } catch { s = String(s); }
  return s.replace(/[\u0000-\u001F\u007F\u00A0]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
}
function normalizeBlockHash(hash) {
  if (!hash) return "";
  if (typeof hash === "string") return hash.replace(/^0x/i, "");
  if (hash instanceof Uint8Array || Buffer.isBuffer(hash))
    return Buffer.from(hash).toString("hex");
  if (typeof hash === "object" && hash.value)
    return normalizeBlockHash(hash.value);
  return String(hash);
}
function normalizeTxHash(h) {
  if (!h) return "";
  if (typeof h === "string") return h.replace(/^0x/i, "");
  if (h instanceof Uint8Array || Buffer.isBuffer(h))
    return Buffer.from(h).toString("hex");
  if (typeof h === "object" && h.value) return normalizeTxHash(h.value);
  return String(h);
}
function extractAccountString(a) {
  if (!a) return null;
  if (typeof a === "string") return a;
  if (typeof a === "object") {
    if (typeof a.address === "string") return a.address;
    if (a.address) return extractAccountString(a.address);
    if (typeof a.account === "string") return a.account;
    if (a.account) return extractAccountString(a.account);
    if (typeof a.value === "string") return a.value;
    if (a.value) return extractAccountString(a.value);
    if (typeof a.accountAddress === "string") return a.accountAddress;
    if (a.accountAddress) return extractAccountString(a.accountAddress);
  }
  return null;
}
function pickSenderFromEvents(events) {
  if (!Array.isArray(events)) return null;
  for (const ev of events) {
    const from =
      extractAccountString(ev?.from) ||
      extractAccountString(ev?.sender) ||
      extractAccountString(ev?.account) ||
      extractAccountString(ev?.owner) ||
      extractAccountString(ev?.address?.account ?? ev?.address);
    if (from) return from;
  }
  return null;
}
function pickSender(item) {
  let s =
    extractAccountString(item?.sender) ||
    extractAccountString(item?.accountAddress) ||
    extractAccountString(item?.initiator) ||
    extractAccountString(item?.summary?.sender);
  if (s) return s;
  const events =
    item?.events ?? item?.summary?.events ?? item?.result?.events ?? [];
  return pickSenderFromEvents(events);
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj, (k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(obj);
  }
}

function getItemEvents(item) {
  return item?.events ?? item?.summary?.events ?? item?.result?.events ?? [];
}
function eventTag(ev) {
  return ev?.tag || ev?.type || ev?._tag || null;
}
function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function normTagName(x) {
  return String(x || "").replace(/[_\s-]/g, "").toLowerCase();
}

function memoFromCLI(txHash) {
  return new Promise((resolve) => {
    const args = [
      "transaction",
      "status",
      txHash,
      "--grpc-ip",
      GRPC_HOST,
      "--grpc-port",
      String(GRPC_PORT),
    ];
    if (USE_TLS) args.push("--secure");

    execFile(CLIENT_PATH, args, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        if (DEBUG) console.log(`[memo][cli] failed for ${txHash}: ${err.message || err}`);
        return resolve({ text: null, hex: null });
      }
      const lines = String(stdout).split(/\r?\n/);
      const idx = lines.findIndex((l) => l.trim() === "Transfer memo:");
      let text = null;
      if (idx !== -1 && idx + 1 < lines.length) {
        text = lines[idx + 1].trim() || null;
      }
      const hex = text ? Buffer.from(text, "utf8").toString("hex") : null;
      return resolve({ text, hex, _raw: lines });
    });
  });
}
function senderFromCLI(txHash) {
  return new Promise((resolve) => {
    const args = [
      "transaction",
      "status",
      txHash,
      "--grpc-ip",
      GRPC_HOST,
      "--grpc-port",
      String(GRPC_PORT),
    ];
    if (USE_TLS) args.push("--secure");

    execFile(CLIENT_PATH, args, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        if (DEBUG) console.log(`[sender][cli] failed for ${txHash}: ${err.message || err}`);
        return resolve(null);
      }
      const m = String(stdout).match(/from account '([^']+)'/);
      resolve(m?.[1] || null);
    });
  });
}
function anyWaiters() {
  return delegatorWaiters.size > 0 || validatorWaiters.size > 0;
}

function setDelegatorWrongMemoNotifier(fn) { delegatorWrongMemoNotifier = typeof fn === "function" ? fn : null; }
function setValidatorWrongMemoNotifier(fn) { validatorWrongMemoNotifier = typeof fn === "function" ? fn : null; }

function setDelegatorWaiterExpiredNotifier(fn) { delegatorExpiredNotifier = typeof fn === "function" ? fn : null; }
function setValidatorWaiterExpiredNotifier(fn) { validatorExpiredNotifier = typeof fn === "function" ? fn : null; }

function registerDelegatorMemoWaiter({
  discordId,
  threadId,
  accountAddress,
  expectedMemo,
  onSuccess,
}) {
  const key = normAddr(accountAddress);
  if (DEBUG) console.log(
    `[waiter] register delegator addr=${key} expected="${expectedMemo}" discordId=${discordId}`
  );
  delegatorWaiters.set(key, { expectedMemo, discordId, threadId, onSuccess, createdAt: Date.now() });
  return () => delegatorWaiters.delete(key);
}
function registerValidatorMemoWaiter({
  discordId,
  threadId,
  validatorId,
  validatorAddress,
  expectedMemo,
  onSuccess,
}) {
  const key = normAddr(validatorAddress);
  if (DEBUG) {
    console.log(
      `[waiter] register validator addr=${key} validatorId=${validatorId} expected="${expectedMemo}" discordId=${discordId}`
    );
  }
  validatorWaiters.set(key, { expectedMemo, validatorId, discordId, threadId, onSuccess, createdAt: Date.now() });
  return () => validatorWaiters.delete(key);
}

function pruneWaiters() {
  const now = Date.now();

  for (const [key, w] of delegatorWaiters) {
    if (now - (w.createdAt || now) > WAITER_TTL_MS) {
      delegatorWaiters.delete(key);
      if (delegatorExpiredNotifier) {
        try { delegatorExpiredNotifier({ discordId: w.discordId, threadId: w.threadId, expected: w.expectedMemo, minutes: WAITER_TTL_MIN }); } catch {}
      }
      if (DEBUG) console.log(`[waiter][delegator] expired addr=${key}`);
    }
  }
  for (const [key, w] of validatorWaiters) {
    if (now - (w.createdAt || now) > WAITER_TTL_MS) {
      validatorWaiters.delete(key);
      if (validatorExpiredNotifier) {
        try { validatorExpiredNotifier({ discordId: w.discordId, threadId: w.threadId, expected: w.expectedMemo, minutes: WAITER_TTL_MIN }); } catch {}
      }
      if (DEBUG) console.log(`[waiter][validator] expired addr=${key}`);
    }
  }
}
let pruneTimer = null;
function ensurePruneTimer() {
  if (pruneTimer) return;
  pruneTimer = setInterval(pruneWaiters, PRUNE_INTERVAL_MS);
  if (typeof pruneTimer.unref === "function") pruneTimer.unref();
}

function extractValidatorId(ev) {
  return toNum(ev?.bakerId ?? ev?.bakerID ?? ev?.baker ?? ev?.validatorId ?? ev?.poolId);
}

async function getBlockTimeIso(grpcClient, blockHash) {
  try {
    const info = await grpcClient.getBlockInfo(blockHash);
    let tsMs = null;
    const candidate =
      info?.blockSlotTime ??
      info?.slotTime ??
      info?.blockInfo?.blockSlotTime ??
      info?.blockInfo?.slotTime ??
      info?.time ??
      null;
    const extract = (v) => {
      if (v == null) return null;
      if (typeof v === "bigint") return Number(v);
      if (typeof v === "number") return v;
      if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? n : null; }
      if (typeof v === "object") {
        if (typeof v.value === "bigint") return Number(v.value);
        if (typeof v.value === "number") return v.value;
        if (typeof v.seconds === "bigint") return Number(v.seconds) * 1000;
        if (typeof v.seconds === "number") return v.seconds * 1000;
      }
      return null;
    };
    let raw = extract(candidate);
    if (raw == null) return null;

    if (raw > 1e15) tsMs = Math.floor(raw / 1e6);       // ns -> ms
    else if (raw > 1e12) tsMs = Math.floor(raw / 1e3);  // µs -> ms
    else if (raw > 1e10) tsMs = Math.floor(raw);        // ~ms
    else if (raw > 1e9) tsMs = Math.floor(raw);         // ms
    else tsMs = Math.floor(raw * 1000);                 // s -> ms

    if (!Number.isFinite(tsMs) || tsMs <= 0) return null;
    return new Date(tsMs).toISOString();
  } catch (e) {
    if (DEBUG) console.log("[grpc] getBlockInfo failed:", e?.message || e);
    return null;
  }
}

function parseDelegationTargetFromEvent(ev) {
  const t = ev?.delegationTarget ?? ev?.target ?? ev?.newDelegationTarget ?? ev?.delegation ?? null;
  if (!t) return null;

  const kind =
    t.delegateType || t.type || t._tag ||
    (t.passive != null ? "Passive" : null) ||
    (t.baker != null || t.bakerId != null || t.poolId != null ? "Baker" : null);

  const k = String(kind || "").toLowerCase();

  if (k === "passive") return { type: "passive" };

  if (k === "baker") {
    const id =
      t.bakerId ?? t.baker ?? t.poolId ??
      (typeof t === "object" && typeof t.id !== "undefined" ? t.id : null);
    const n = Number(id);
    if (Number.isFinite(n)) return { type: "pool", poolId: n };
  }

  const directId = ev?.bakerId ?? ev?.poolId;
  if (Number.isFinite(Number(directId))) {
    return { type: "pool", poolId: Number(directId) };
  }

  return null;
}

async function handleTxAlerts(events, { txHash, blockHash, timestampIso }) {
  const newDelegatorsInTx = new Set();

  const bakerAddedMap = new Map();

  for (const e of events) {
    const t = eventTag(e);
    if (!t) continue;

    if (t === "DelegationAdded") {
      const id = toNum(e?.delegatorId ?? e?.delegator_id);
      if (id != null) newDelegatorsInTx.add(id);
    }

    if (t === "BakerAdded") {
      const vid = extractValidatorId(e);
      if (vid != null) {
        const current = bakerAddedMap.get(String(vid)) || {};
        current.sawAdded = true;
        current.account = extractAccountString(e?.account) || current.account || null;
        current.stakeMicro = toNum(e?.stake) ?? current.stakeMicro ?? null;
        if (typeof e?.restakeEarnings === "boolean") current.restakeEarnings = e.restakeEarnings;
        bakerAddedMap.set(String(vid), current);
      }
    } else if (t === "BakerSetRestakeEarnings") {
      const vid = extractValidatorId(e);
      if (vid != null) {
        const current = bakerAddedMap.get(String(vid)) || {};
        if (typeof e?.restakeEarnings === "boolean") current.restakeEarnings = e.restakeEarnings;
        current.account = extractAccountString(e?.account) || current.account || null;
        bakerAddedMap.set(String(vid), current);
      }
    } else if (t === "BakerSetOpenStatus") {
      const vid = extractValidatorId(e);
      if (vid != null) {
        const current = bakerAddedMap.get(String(vid)) || {};
        current.openStatus = e?.openStatus || current.openStatus || null;
        current.account = extractAccountString(e?.account) || current.account || null;
        bakerAddedMap.set(String(vid), current);
      }
    } else if (t === "BakerSetTransactionFeeCommission") {
      const vid = extractValidatorId(e);
      if (vid != null) {
        const current = bakerAddedMap.get(String(vid)) || {};
        current.txFee = toNum(e?.transactionFeeCommission);
        current.account = extractAccountString(e?.account) || current.account || null;
        bakerAddedMap.set(String(vid), current);
      }
    } else if (t === "BakerSetBakingRewardCommission") {
      const vid = extractValidatorId(e);
      if (vid != null) {
        const current = bakerAddedMap.get(String(vid)) || {};
        current.baking = toNum(e?.bakingRewardCommission);
        current.account = extractAccountString(e?.account) || current.account || null;
        bakerAddedMap.set(String(vid), current);
      }
    } else if (t === "BakerSetFinalizationRewardCommission") {
      const vid = extractValidatorId(e);
      if (vid != null) {
        const current = bakerAddedMap.get(String(vid)) || {};
        current.finalization = toNum(e?.finalizationRewardCommission);
        current.account = extractAccountString(e?.account) || current.account || null;
        bakerAddedMap.set(String(vid), current);
      }
    } else if (t === "BakerSetMetadataURL") {
      const vid = extractValidatorId(e);
      if (vid != null) {
        const current = bakerAddedMap.get(String(vid)) || {};
        current.metadataUrl = (e?.metadataURL ?? e?.metadataUrl ?? "").trim();
        current.account = extractAccountString(e?.account) || current.account || null;
        bakerAddedMap.set(String(vid), current);
      }
    }
  }

  for (const ev of events) {
    const tag = eventTag(ev);
    if (!tag) continue;

    if (tag === "DelegationRemoved") {
      const delegatorId = toNum(ev?.delegatorId ?? ev?.delegator_id);
      const account =
        extractAccountString(ev?.account) ||
        extractAccountString(ev?.address) ||
        extractAccountString(ev?.owner);

      if (delegatorId != null) {
        let mappings = [];
        try {
          mappings = await vdel.getPoolsForDelegator(delegatorId);
        } catch (e) {
          if (DEBUG) console.warn("[vdel] getPoolsForDelegator failed:", e?.message || e);
        }

        if (mappings && mappings.length) {
          for (const m of mappings) {
            const vid = m.validator_id ?? m.validatorId ?? m.pool_id ?? m.poolId;
            const acc = account || m.account_address || m.account;
            try {
              await alerts.handleDelegatorLeftPool({
                validatorId: String(vid),
                delegatorId: String(delegatorId),
                account: String(acc || ""),
                txHash,
                blockHash,
                timestampIso,
              });
            } catch (e) {
              if (DEBUG) console.warn("[alerts] handleDelegatorLeftPool failed:", e?.message || e);
            }
          }
        } else if (DEBUG) {
          console.log(`[vdel] no mapping for delegator ${delegatorId} at removal; skip validator DM`);
        }

        try { await vdel.markDelegatorInactiveEverywhere(delegatorId); } catch {}
      }
    }

    if (tag === "DelegationSetDelegationTarget") {
      const delegatorId = toNum(ev?.delegatorId ?? ev?.delegator_id);
      const account     = extractAccountString(ev?.account);
      const target      = parseDelegationTargetFromEvent(ev);

      if (delegatorId != null && account && target) {
        if (target.type === "passive") {
          let mappings = [];
          try {
            mappings = await vdel.getPoolsForDelegator(delegatorId);
          } catch (e) {
            if (DEBUG) console.warn("[vdel] getPoolsForDelegator failed:", e?.message || e);
          }

          if (mappings && mappings.length) {
            for (const m of mappings) {
              const vid = m.validator_id ?? m.validatorId ?? m.pool_id ?? m.poolId;
              const acc = account || m.account_address || m.account;
              try {
                await alerts.handleDelegatorLeftPool({
                  validatorId: String(vid),
                  delegatorId: String(delegatorId),
                  account: String(acc || ""),
                  txHash,
                  blockHash,
                  timestampIso,
                });
              } catch (e) {
                if (DEBUG) console.warn("[alerts] handleDelegatorLeftPool failed:", e?.message || e);
              }
            }
          }

          try { await vdel.markDelegatorInactiveEverywhere(delegatorId); } catch {}
        } else if (target.type === "pool" && Number.isFinite(target.poolId)) {
          const newPoolId = Number(target.poolId);

          let oldMappings = [];
          try {
            oldMappings = await vdel.getPoolsForDelegator(delegatorId);
          } catch (e) {
            if (DEBUG) console.warn("[vdel] getPoolsForDelegator failed:", e?.message || e);
          }

          if (oldMappings && oldMappings.length) {
            for (const m of oldMappings) {
              const oldVid = Number(m.validator_id ?? m.validatorId ?? m.pool_id ?? m.poolId);
              if (Number.isFinite(oldVid) && oldVid !== newPoolId) {
                const acc = account || m.account_address || m.account;
                try {
                  await alerts.handleDelegatorLeftPool({
                    validatorId: String(oldVid),
                    delegatorId: String(delegatorId),
                    account: String(acc || ""),
                    txHash,
                    blockHash,
                    timestampIso,
                  });
                } catch (e) {
                  if (DEBUG) console.warn("[alerts] handleDelegatorLeftPool failed:", e?.message || e);
                }
              }
            }
          }

          const wasInSamePool =
            Array.isArray(oldMappings) &&
            oldMappings.some((m) => Number(m.validator_id ?? m.validatorId ?? m.pool_id ?? m.poolId) === newPoolId);

          if (!wasInSamePool) {
            if (!newDelegatorsInTx.has(delegatorId)) {
              try {
                await alerts.handleDelegatorJoinedPool({
                  validatorId: String(newPoolId),
                  delegatorId: String(delegatorId),
                  account: String(account || ""),
                  txHash,
                  blockHash,
                  timestampIso,
                });
              } catch (e) {
                if (DEBUG) console.warn("[alerts] handleDelegatorJoinedPool failed:", e?.message || e);
              }
            }
          }

          try { await vdel.setDelegatorActiveForPool(delegatorId, account, newPoolId); } catch {}
        }
      }
    }

    if (tag === "DelegationStakeIncreased") {
      const account = extractAccountString(ev?.account);
      const newStakeMicro = Number(ev?.newStake);
      if (account && Number.isFinite(newStakeMicro)) {
        try {
          await alerts.handleDelegatorStakeIncreased({
            account,
            newStakeMicro,
            txHash,
            blockHash,
            timestampIso,
          });
        } catch (e) {
          if (DEBUG) console.warn("[alerts] handleDelegatorStakeIncreased failed:", e?.message || e);
        }
      }

      const delegatorId = toNum(ev?.delegatorId ?? ev?.delegator_id);
      if (delegatorId != null) {
        if (newDelegatorsInTx.has(delegatorId)) {
          if (DEBUG) console.log("[alerts] skip stake-change DM for new delegator in same tx", { delegatorId, txHash });
        } else {
          let mappings = [];
          try { mappings = await vdel.getPoolsForDelegator(delegatorId); } catch {}
          if (Array.isArray(mappings) && mappings.length) {
            for (const m of mappings) {
              const vid = Number(m.validator_id ?? m.validatorId ?? m.pool_id ?? m.poolId);
              if (!Number.isFinite(vid)) continue;
              const acc = account || m.account_address || "";
              try {
                await alerts.handleDelegatorStakeChangedForValidator({
                  validatorId: String(vid),
                  delegatorId: String(delegatorId),
                  account: String(acc),
                  direction: "increased",
                  newStakeMicro: String(ev?.newStake),
                  txHash,
                  blockHash,
                  timestampIso,
                });
              } catch (e) {
                if (DEBUG) console.warn("[alerts] handleDelegatorStakeChangedForValidator (inc) failed:", e?.message || e);
              }
            }
          }
        }
      }

      const delegatorIdND = ev?.delegatorId ?? ev?.delegator_id;
      if (delegatorIdND != null && ev?.newStake != null) {
        try {
          await alerts.handleNewDelegator_StakeIncreased({
            delegatorId: String(delegatorIdND),
            newStakeMicro: String(ev.newStake),
            txHash,
          });
        } catch (e) {
          if (DEBUG) console.warn("[alerts] handleNewDelegator_StakeIncreased failed:", e?.message || e);
        }
      }
    }
    else if (tag === "DelegationStakeDecreased") {
      const account = extractAccountString(ev?.account);
      const newStakeMicro = Number(ev?.newStake);
      if (account && Number.isFinite(newStakeMicro)) {
        try {
          await alerts.handleDelegatorStakeDecreased({
            account,
            newStakeMicro,
            txHash,
            blockHash,
            timestampIso,
          });
        } catch (e) {
          if (DEBUG) console.warn("[alerts] handleDelegatorStakeDecreased failed:", e?.message || e);
        }
      }

      const delegatorId = toNum(ev?.delegatorId ?? ev?.delegator_id);
      if (delegatorId != null) {
        let mappings = [];
        try { mappings = await vdel.getPoolsForDelegator(delegatorId); } catch {}
        if (Array.isArray(mappings) && mappings.length) {
          for (const m of mappings) {
            const vid = Number(m.validator_id ?? m.validatorId ?? m.pool_id ?? m.poolId);
            if (!Number.isFinite(vid)) continue;
            const acc = account || m.account_address || "";
            try {
              await alerts.handleDelegatorStakeChangedForValidator({
                validatorId: String(vid),
                delegatorId: String(delegatorId),
                account: String(acc),
                direction: "decreased",
                newStakeMicro: String(ev?.newStake),
                txHash,
                blockHash,
                timestampIso,
              });
            } catch (e) {
              if (DEBUG) console.warn("[alerts] handleDelegatorStakeChangedForValidator (dec) failed:", e?.message || e);
            }
          }
        }
      }
    }

    if (tag === "DelegationAdded") {
      const delegatorId = ev?.delegatorId ?? ev?.delegator_id;
      const account     = extractAccountString(ev?.account);
      if (delegatorId != null && account) {
        try {
          await alerts.handleNewDelegator_DelegationAdded({
            delegatorId: String(delegatorId),
            account: String(account),
            txHash,
          });
        } catch (e) {
          if (DEBUG) console.warn("[alerts] handleNewDelegator_DelegationAdded failed:", e?.message || e);
        }
      }
    }

    if (tag === "DelegationSetDelegationTarget") {
      const delegatorId = ev?.delegatorId ?? ev?.delegator_id;
      const t = parseDelegationTargetFromEvent(ev);
      if (delegatorId != null && t?.type === "pool" && Number.isFinite(t.poolId)) {
        try {
          await alerts.handleNewDelegator_TargetSet({
            delegatorId: String(delegatorId),
            bakerId: String(t.poolId),
            txHash,
          });
        } catch (e) {
          if (DEBUG) console.warn("[alerts] handleNewDelegator_TargetSet failed:", e?.message || e);
        }
      }
    }

    if (tag === "BakerSetTransactionFeeCommission") {
      const validatorIdNum = extractValidatorId(ev);
      const transactionFeeCommission = toNum(ev?.transactionFeeCommission);
      if (validatorIdNum != null && transactionFeeCommission != null) {
        try {
          await alerts.handleCommissionUpdate({
            validatorId: String(validatorIdNum),
            bakingRewardCommission: null,
            transactionFeeCommission,
            blockHash,
            txHash,
            timestampIso,
          });
        } catch (e) {
          if (DEBUG) console.warn("[alerts] handleCommissionUpdate (tx fee) failed:", e?.message || e);
        }
      }
    } else if (tag === "BakerSetBakingRewardCommission") {
      const validatorIdNum = extractValidatorId(ev);
      const bakingRewardCommission = toNum(ev?.bakingRewardCommission);
      if (validatorIdNum != null && bakingRewardCommission != null) {
        try {
          await alerts.handleCommissionUpdate({
            validatorId: String(validatorIdNum),
            bakingRewardCommission,
            transactionFeeCommission: null,
            blockHash,
            txHash,
            timestampIso,
          });
        } catch (e) {
          if (DEBUG) console.warn("[alerts] handleCommissionUpdate (baking) failed:", e?.message || e);
        }
      }
    }
    else if (tag === "BakerSuspended") {
      const validatorIdNum = extractValidatorId(ev);
      if (validatorIdNum != null) {
        try {
          await alerts.handleValidatorSuspended({
            validatorId: String(validatorIdNum),
            blockHash,
            txHash,
            timestampIso,
          });
        } catch (e) {
          if (DEBUG) console.warn("[alerts] handleValidatorSuspended failed:", e?.message || e);
        }
      }
    }
    else if (tag === "BakerResumed") {
      const validatorIdNum = extractValidatorId(ev);
      if (validatorIdNum != null) {
        try {
          await alerts.handleValidatorResumed({
            validatorId: String(validatorIdNum),
            blockHash,
            txHash,
            timestampIso,
          });
        } catch (e) {
          if (DEBUG) console.warn("[alerts] handleValidatorResumed failed:", e?.message || e);
        }
      }
    }
    else if (tag === "DelegationSetDelegationTarget") {
      const target = parseDelegationTargetFromEvent(ev);
      const account =
        extractAccountString(ev?.account) ||
        extractAccountString(ev?.address) ||
        extractAccountString(ev?.owner);

      if (account && target) {
        const newTarget =
          target.type === "passive" ? "passive" : String(target.poolId);

        try {
          await alerts.handleDelegationTargetChanged({
            account,
            newTarget,
            blockHash,
            txHash,
            timestampIso,
          });
        } catch (e) {
          if (DEBUG) console.warn("[alerts] handleDelegationTargetChanged failed:", e?.message || e);
        }
      }
    }
    else if (tag === "BakerRemoved") {
      const validatorId = extractValidatorId(ev);
      const account = extractAccountString(ev?.account)
                  || extractAccountString(ev?.address)
                  || extractAccountString(ev?.owner);
      if (validatorId != null) {
        let impactedDiscordIds = [];
        try {
          impactedDiscordIds = await alerts.getDelegatorDiscordIdsByValidator(String(validatorId));
        } catch (e) {
          if (DEBUG) console.warn("[alerts] getDelegatorDiscordIdsByValidator failed:", e?.message || e);
        }

        try {
          await alerts.handleValidatorRemoved({
            validatorId,
            blockHash,
            txHash,
            timestampIso,
          });
        } catch (e) {
          if (DEBUG) console.warn("[alerts] handleValidatorRemoved failed:", e?.message || e);
        }

        try {
          await alerts.handleNetworkValidatorRemoved({
            validatorId,
            account: account ? String(account) : null,
            txHash,
            blockHash,
            excludeDiscordIds: impactedDiscordIds,
          });
        } catch (e) {
          if (DEBUG) console.warn("[alerts] handleNetworkValidatorRemoved failed:", e?.message || e);
        }
      }
    }
    else if (tag === "BakerStakeIncreased") {
      const validatorIdNum = extractValidatorId(ev);
      const newStakeMicro = toNum(ev?.newStake);
      const account = extractAccountString(ev?.account);
      if (validatorIdNum != null && newStakeMicro != null) {
        try {
          await alerts.handleValidatorStakeIncreased({
            validatorId: String(validatorIdNum),
            account: account ? String(account) : null,
            newStakeMicro,
            txHash,
            blockHash,
            timestampIso,
          });
        } catch (e) {
          if (DEBUG) console.warn("[alerts] handleValidatorStakeIncreased failed:", e?.message || e);
        }
      }
    }
    else if (tag === "BakerStakeDecreased") {
      const validatorIdNum = extractValidatorId(ev);
      const account = extractAccountString(ev?.account)
                   || extractAccountString(ev?.address)
                   || extractAccountString(ev?.owner);
      const newStakeMicro = toNum(ev?.newStake);
      if (validatorIdNum != null && account && newStakeMicro != null) {
        try {
          await alerts.handleValidatorStakeDecreased({
            validatorId: String(validatorIdNum),
            account: String(account),
            newStakeMicro,
            txHash,
            blockHash,
            timestampIso,
          });
        } catch (e) {
          if (DEBUG) console.warn("[alerts] handleValidatorStakeDecreased failed:", e?.message || e);
        }
      }
    }
  }

  if (bakerAddedMap.size) {
    for (const [vid, info] of bakerAddedMap) {
      if (info?.sawAdded === true) {
        try {
          await alerts.handleNetworkValidatorAdded({
            validatorId: String(vid),
            account: info.account || null,
            stakeMicro: info.stakeMicro ?? null,
            openStatus: info.openStatus ?? null,
            commissions: {
              baking: typeof info.baking === "number" ? info.baking : undefined,
              txFee: typeof info.txFee === "number" ? info.txFee : undefined,
              finalization: typeof info.finalization === "number" ? info.finalization : undefined,
            },
            txHash,
            blockHash,
            metadataUrl: info.metadataUrl || null,
          });
        } catch (e) {
          if (DEBUG) console.warn("[alerts] handleNetworkValidatorAdded failed:", e?.message || e);
        }
      }
    }
  }
}

async function handleSpecialAlerts(tag, payload, { blockHash, timestampIso }) {
  const t = normTagName(tag);

  if (t === "validatorprimedforsuspension") {
    const validatorIdNum = extractValidatorId(payload);
    if (validatorIdNum != null) {
      try {
        await alerts.handleValidatorPrimed({
          validatorId: String(validatorIdNum),
          blockHash,
          timestampIso,
        });
      } catch (e) {
        if (DEBUG) console.warn("[alerts] handleValidatorPrimed failed:", e?.message || e);
      }
    }
  } else if (t === "validatorsuspended") {
    const validatorIdNum = extractValidatorId(payload);
    if (validatorIdNum != null) {
      try {
        await alerts.handleValidatorSuspended({
          validatorId: String(validatorIdNum),
          blockHash,
          timestampIso,
        });
      } catch (e) {
        if (DEBUG) console.warn("[alerts] handleValidatorSuspended (special) failed:", e?.message || e);
      }
    }
  }
  else if (t === "paydayaccountreward") {
    try {
      const account = extractAccountString(payload?.account);
      const transactionFees    = toNum(payload?.transactionFees);
      const bakerReward        = toNum(payload?.bakerReward);
      const finalizationReward = toNum(payload?.finalizationReward);

      if (account) {
        try {
          await alerts.handleValidatorPaydayAccountReward({
            account,
            transactionFees,
            bakerReward,
            finalizationReward,
            blockHash,
            timestampIso,
          });
        } catch (e1) {
          if (DEBUG) console.warn("[alerts] handleValidatorPaydayAccountReward failed:", e1?.message || e1);
        }

        try {
          await alerts.handleDelegatorPaydayAccountReward({
            account,
            transactionFees,
            bakerReward,
            finalizationReward,
            blockHash,
            timestampIso,
          });
        } catch (e2) {
          if (DEBUG) console.warn("[alerts] handleDelegatorPaydayAccountReward failed:", e2?.message || e2);
        }
      }
    } catch (e) {
      if (DEBUG) console.warn("[alerts] paydayAccountReward fan-out failed:", e?.message || e);
    }
  }
}

async function processBlock(grpcClient, blockHash, height) {
  const hash = normalizeBlockHash(blockHash);
  if (LOG_BLOCKS) {
    console.log(`🧱 [grpc] new block ${hash} (height=${height ?? "?"})`);
  }

  const blockTimeIso = await getBlockTimeIso(grpcClient, blockHash);

  try {
    for await (const item of grpcClient.getBlockTransactionEvents(blockHash)) {
      const txHash = normalizeTxHash(
        item?.hash ?? item?.transactionHash ?? item?.blockItem
      );

      const haveWaiters = anyWaiters();

      let sender = pickSender(item);

      if (haveWaiters && !sender && txHash) {
        sender = await senderFromCLI(txHash);
      }

      const key = normAddr(sender);
      const hasDelegatorWaiter = !!(sender && delegatorWaiters.has(key));
      const hasValidatorWaiter = !!(sender && validatorWaiters.has(key));

      if (haveWaiters && DEBUG) {
        console.log(
          `[debug] tx=${txHash} sender=${sender || "<none>"} waiterD=${hasDelegatorWaiter} waiterV=${hasValidatorWaiter}`
        );
      }

      let memo = { text: null, hex: null };

      if ((hasDelegatorWaiter || hasValidatorWaiter) && txHash) {
        memo = await memoFromCLI(txHash);
        if (DEBUG && memo.text) {
          console.log(`[memo] extracted via cli: "${memo.text}" (hex:${memo.hex}) tx=${txHash}`);
        }
      }

      if (hasDelegatorWaiter) {
        const w = delegatorWaiters.get(key);
        const ok = memo.text && normMemo(memo.text) === normMemo(w.expectedMemo);
        if (ok) {
          try {
            await w.onSuccess?.({
              txHash,
              blockHash: hash,
              sender,
              memoText: memo.text,
              memoHex: memo.hex,
              timestampIso: blockTimeIso,
            });
          } finally {
            delegatorWaiters.delete(key);
          }
        } else if (memo.text && delegatorWrongMemoNotifier) {
          try {
            await delegatorWrongMemoNotifier({
              discordId: w.discordId,
              threadId: w.threadId,
              expected: w.expectedMemo,
              got: memo.text,
            });
          } catch {}
        }
      }

      if (hasValidatorWaiter) {
        const vw = validatorWaiters.get(key);
        const ok = memo.text && normMemo(memo.text) === normMemo(vw.expectedMemo);
        if (ok) {
          try {
            await vw.onSuccess?.({
              txHash,
              blockHash: hash,
              sender,
              memoText: memo.text,
              memoHex: memo.hex,
              validatorId: vw.validatorId,
              timestampIso: blockTimeIso,
            });
          } finally {
            validatorWaiters.delete(key);
          }
        } else if (memo.text && validatorWrongMemoNotifier) {
          try {
            await validatorWrongMemoNotifier({
              discordId: vw.discordId,
              threadId: vw.threadId,
              expected: vw.expectedMemo,
              got: memo.text,
            });
          } catch {}
        }
      }

      const events = getItemEvents(item);
      if (txHash) {
        if (LOG_TX) {
          if (memo.text) {
            console.log(`↪︎ [grpc] tx ${txHash} memo="${memo.text}" (hex:${memo.hex}) in block ${hash}`);
          } else {
            console.log(`↪︎ [grpc] tx ${txHash} in block ${hash}`);
          }
        }

        if (events && events.length) {
          try {
            await handleTxAlerts(events, { txHash, blockHash: hash, timestampIso: blockTimeIso });
          } catch (e) {
            if (DEBUG) console.warn("[alerts] handleTxAlerts failed:", e?.message || e);
          }
        }

        if (LOG_TX_EVENTS && events && events.length) {
          for (const ev of events) {
            const tag = eventTag(ev);
            if (EVENT_TAGS_SET && (!tag || !EVENT_TAGS_SET.has(tag))) continue;

            const details = { ...ev };
            delete details.tag; delete details.type; delete details._tag;

            const detailsStr = safeJson(details);
            const suffix = detailsStr && detailsStr !== "{}" ? ` ${detailsStr}` : "";
            console.log(`• [grpc] event ${tag || "unknown"}${suffix} in tx ${txHash} block ${hash}`);
          }
        }
      }
    }
  } catch (e) {
    console.warn("[grpc] getBlockTransactionEvents failed:", e?.message || e);
  }

  try {
    for await (const se of grpcClient.getBlockSpecialEvents(blockHash)) {
      const tag = se?.tag || se?.type || se?._tag;

      if (tag) {
        try {
          await handleSpecialAlerts(tag, se, { blockHash: hash, timestampIso: blockTimeIso });
        } catch (e) {
          if (DEBUG) console.warn("[alerts] handleSpecialAlerts failed:", e?.message || e);
        }
      }

      if (LOG_SPECIAL) {
        if (SPECIAL_TAGS_SET && tag && !SPECIAL_TAGS_SET.has(tag)) continue;

        const details = [];
        for (const [k, v] of Object.entries(se || {})) {
          if (k === "tag" || k === "type" || k === "_tag") continue;
          if (v == null) continue;
          details.push(`${k}=${typeof v === "object" ? safeJson(v) : v}`);
        }
        console.log(
          `⋯ [grpc] special ${tag}${details.length ? " " + details.join(" ") : ""} in block ${hash}`
        );
      }
    }
  } catch (e) {
    console.warn("[grpc] getBlockSpecialEvents failed:", e?.message || e);
  }
}

let lastHeight = null;

async function startTxLoggerListener() {
  if (!ConcordiumGRPCNodeClient) {
    ({ ConcordiumGRPCNodeClient, credentials } = await import("@concordium/web-sdk/nodejs"));
  }
  const creds = USE_TLS ? credentials.createSsl() : credentials.createInsecure();
  const grpcClient = new ConcordiumGRPCNodeClient(GRPC_HOST, GRPC_PORT, creds);

  console.log(`🔌 [grpc] connecting to ${GRPC_HOST}:${GRPC_PORT} (tls=${USE_TLS ? "on" : "off"})`);

  await grpcClient
    .getConsensusStatus()
    .then(() => console.log("✅ [grpc] consensus status OK, starting block stream"))
    .catch((e) => { throw new Error(`Could not reach node: ${e?.message || e}`); });

  ensurePruneTimer();

  while (true) {
    try {
      const stream =
        lastHeight == null
          ? grpcClient.getFinalizedBlocks()
          : grpcClient.getFinalizedBlocksFrom(BigInt(lastHeight + 1));

      for await (const b of stream) {
        const h =
          typeof b.height === "bigint"
            ? Number(b.height)
            : typeof b.blockHeight === "bigint"
            ? Number(b.blockHeight)
            : Number(b.height ?? b.blockHeight ?? 0);

        const hash = b.hash ?? b.blockHash;

        if (lastHeight != null && h > lastHeight + 1) {
          const missingFrom = lastHeight + 1;
          const missingTo = h - 1;
          console.warn(`⚠️ [grpc] height gap: had ${lastHeight}, got ${h}. Backfilling ${missingFrom}..${missingTo}`);
          for (let hh = missingFrom; hh <= missingTo; hh++) {
            try {
              for await (const bh of grpcClient.getBlocksAtHeight(BigInt(hh))) {
                await processBlock(grpcClient, bh, hh);
                break;
              }
            } catch (e) {
              console.warn(`[grpc] backfill failed at height ${hh}:`, e?.message || e);
            }
          }
        }

        await processBlock(grpcClient, hash, h);
        lastHeight = h;
      }

      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.error(`❌ [grpc] listener error: ${err?.message || err}. Reconnecting in 1000ms...`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function pingTxLogger() {
  if (!ConcordiumGRPCNodeClient) {
    ({ ConcordiumGRPCNodeClient, credentials } = await import("@concordium/web-sdk/nodejs"));
  }
  const creds = USE_TLS ? credentials.createSsl() : credentials.createInsecure();
  const grpcClient = new ConcordiumGRPCNodeClient(GRPC_HOST, GRPC_PORT, creds);
  await grpcClient.getConsensusStatus();
  return true;
}

module.exports = {
  startTxLoggerListener,
  pingTxLogger,
  registerDelegatorMemoWaiter,
  setDelegatorWrongMemoNotifier,
  setDelegatorWaiterExpiredNotifier,
  registerValidatorMemoWaiter,
  setValidatorWrongMemoNotifier,
  setValidatorWaiterExpiredNotifier,
};