/**
 * Check new payments against the bank without anyone pressing a button.
 *
 * A payment added in the ERP queues a check. After a short delay (so a burst of
 * entries becomes one run) the statement is fetched for the payment dates up to
 * today, when a live bank connection is configured, and the reconciliation
 * engine runs over that range. Statement fetches are spaced at least
 * BANKING_AUTO_FETCH_GAP_MINUTES apart, since ICICI rate-limits the API.
 *
 * Off with BANKING_AUTO_CHECK_ON_PAYMENT=false.
 */

import { getIciciCorporateConfig } from "../config/iciciCorporate.config.js";
import { fetchAndStoreCorporateStatement } from "./iciciCorporateStatement.service.js";
import { runEnhancedReconciliation } from "./reconciliationEngine.service.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

const DAY_MS = 24 * 60 * 60 * 1000;
const DELAY_MS = Number(process.env.BANKING_AUTO_CHECK_DELAY_SECONDS || 90) * 1000;
const FETCH_GAP_MS = Number(process.env.BANKING_AUTO_FETCH_GAP_MINUTES || 10) * 60 * 1000;
/** A payment back-dated further than this is left to the hourly sweep. */
const MAX_LOOKBACK_DAYS = 7;

const enabled = () => process.env.BANKING_AUTO_CHECK_ON_PAYMENT !== "false";

let timer = null;
let queuedFrom = null;
let running = null;
let lastFetchAt = 0;

const ymd = (d) => new Date(d.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);

function clampFrom(date, now) {
  const floor = new Date(now.getTime() - MAX_LOOKBACK_DAYS * DAY_MS);
  const d = date && !Number.isNaN(new Date(date).getTime()) ? new Date(date) : now;
  const from = new Date(Math.min(d.getTime(), now.getTime() - DAY_MS));
  return from < floor ? floor : from;
}

export function liveBankConfigured(cfg = getIciciCorporateConfig()) {
  return Boolean(cfg.useHttp && !cfg.useStub);
}

/**
 * Fetch the statement for a range if the bank is connected and the last fetch
 * was long enough ago. Never throws: a bank outage must not break the caller.
 */
export async function fetchStatementIfDue(from, to, { force = false } = {}) {
  if (!liveBankConfigured()) return { fetched: false, reason: "no live bank connection" };
  const now = Date.now();
  if (!force && now - lastFetchAt < FETCH_GAP_MS) return { fetched: false, reason: "fetched recently" };
  lastFetchAt = now;
  try {
    const result = await fetchAndStoreCorporateStatement(ymd(from), ymd(to), null);
    return { fetched: true, inserted: result?.inserted ?? 0 };
  } catch (err) {
    log().warn("Automatic statement fetch failed", { error: err.message });
    return { fetched: false, reason: err.message };
  }
}

/** Fetch (when due) and reconcile from `from` to now. */
export async function runBankCheck({ from, reason = "payment" } = {}) {
  const now = new Date();
  const start = clampFrom(from, now);
  const fetch = await fetchStatementIfDue(start, now);
  const result = await runEnhancedReconciliation(start, now, { source: "all" });
  log().info("Automatic bank check complete", {
    reason,
    from: ymd(start),
    fetched: fetch.fetched,
    fetchNote: fetch.reason,
    verified: result.updatedCount,
    suspense: result.suspense?.length,
    cashMatches: result.cashMatches,
    depositsMatched: result.depositsMatched,
  });
  return { ...result, fetch };
}

async function drain() {
  timer = null;
  const from = queuedFrom;
  queuedFrom = null;
  if (running) {
    queueBankCheck({ paymentDate: from });
    return;
  }
  running = runBankCheck({ from, reason: "payment" })
    .catch((err) => log().error("Automatic bank check failed", { error: err.message }))
    .finally(() => {
      running = null;
    });
  await running;
}

/** Queue a bank check for a payment just added. Safe to call from any request handler. */
export function queueBankCheck({ paymentDate } = {}) {
  if (!enabled()) return;
  const d = paymentDate ? new Date(paymentDate) : new Date();
  const when = Number.isNaN(d.getTime()) ? new Date() : d;
  if (!queuedFrom || when < queuedFrom) queuedFrom = when;
  if (timer) return;
  timer = setTimeout(() => {
    void drain();
  }, DELAY_MS);
  timer.unref?.();
}

/** For tests: flush the queue now. */
export async function flushBankCheckQueue() {
  if (timer) clearTimeout(timer);
  if (queuedFrom) await drain();
  else if (running) await running;
}
