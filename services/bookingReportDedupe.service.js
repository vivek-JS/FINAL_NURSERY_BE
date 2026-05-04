/**
 * Prevents duplicate PDF sends when WATI retries the same webhook after a **successful** send.
 * Only records completion after the full flow succeeds; failed runs can be retried.
 * In-memory (single Node process). Tune with BOOKING_REPORT_DEDUPE_MS (default 5 min).
 */

const WINDOW_MS = parseInt(
  process.env.BOOKING_REPORT_DEDUPE_MS || String(5 * 60 * 1000),
  10
);

/** @type {Map<string, number>} */
const seen = new Map();

function prune(now) {
  for (const [k, t] of seen.entries()) {
    if (now - t > WINDOW_MS) {
      seen.delete(k);
    }
  }
}

function getDedupeKey(body) {
  if (!body || typeof body !== "object") {
    return "";
  }
  const key =
    body.whatsappMessageId ||
    body.id ||
    body.webhookId ||
    body.eventId ||
    "";
  if (!key || String(key).length < 8) {
    return "";
  }
  return String(key);
}

/**
 * @param {object} body - Raw WATI webhook body
 * @returns {boolean} true if this message id was already completed recently (skip send)
 */
export function shouldSkipDuplicateBookingReport(body) {
  const k = getDedupeKey(body);
  if (!k) {
    return false;
  }
  const now = Date.now();
  prune(now);
  if (seen.has(k)) {
    console.log(
      `[booking report] Dedupe: skip duplicate webhook key ${k.slice(0, 24)}…`
    );
    return true;
  }
  return false;
}

/**
 * Call after PDF + file message (and figures text) succeeded.
 * @param {object} body
 */
export function recordBookingReportSuccessfullySent(body) {
  const k = getDedupeKey(body);
  if (!k) {
    return;
  }
  const now = Date.now();
  prune(now);
  seen.set(k, now);
}
