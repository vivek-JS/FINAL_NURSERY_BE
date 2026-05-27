/**
 * Farmer order payment timing: advance (before first dispatch) vs balance (on/after dispatch).
 */

/** @typedef {"advance"|"balance"} StoredPaymentTiming */
/** @typedef {"advance"|"after_dispatch"|"other"} ApiPaymentTiming */

/**
 * @param {Record<string, unknown>} row
 * @returns {Date|null}
 */
export function getFirstDispatchAt(row) {
  const hist = row.dispatchHistory;
  if (Array.isArray(hist) && hist.length) {
    const dates = hist
      .map((h) => h?.date)
      .filter(Boolean)
      .map((d) => new Date(d))
      .filter((d) => !Number.isNaN(d.getTime()));
    if (dates.length) {
      dates.sort((a, b) => a - b);
      return dates[0];
    }
  }
  const changes = row.statusChanges;
  if (Array.isArray(changes)) {
    const dispatched = changes
      .filter((c) => c?.newStatus === "DISPATCHED" && c?.createdAt)
      .map((c) => new Date(c.createdAt))
      .filter((d) => !Number.isNaN(d.getTime()));
    if (dispatched.length) {
      dispatched.sort((a, b) => a - b);
      return dispatched[0];
    }
  }
  if (row.dispatchTargetDate) return new Date(row.dispatchTargetDate);
  return null;
}

/**
 * @param {Date|null} firstDispatchAt
 * @returns {string|null} ISO string or null
 */
export function firstDispatchAtIso(firstDispatchAt) {
  if (!firstDispatchAt || Number.isNaN(firstDispatchAt.getTime())) return null;
  return firstDispatchAt.toISOString();
}

/** Advance = COLLECTED payment before first dispatch (or order not dispatched yet). */
export function isAdvancePayment(payment, firstDispatchAtIso) {
  if (!payment || payment.paymentStatus !== "COLLECTED") return false;
  if (!(Number(payment.paidAmount) > 0)) return false;
  if (!firstDispatchAtIso) return true;
  const payDt = payment.paymentDate ? new Date(payment.paymentDate) : null;
  const dispDt = new Date(firstDispatchAtIso);
  if (!payDt || Number.isNaN(payDt.getTime()) || Number.isNaN(dispDt.getTime())) {
    return true;
  }
  return payDt.getTime() < dispDt.getTime();
}

/** Balance = COLLECTED on/after first dispatch date. */
export function isBalancePayment(payment, firstDispatchAtIso) {
  if (!payment || payment.paymentStatus !== "COLLECTED") return false;
  if (!(Number(payment.paidAmount) > 0)) return false;
  if (!firstDispatchAtIso) return false;
  const payDt = payment.paymentDate ? new Date(payment.paymentDate) : null;
  const dispDt = new Date(firstDispatchAtIso);
  if (!payDt || Number.isNaN(payDt.getTime()) || Number.isNaN(dispDt.getTime())) {
    return false;
  }
  return payDt.getTime() >= dispDt.getTime();
}

/**
 * Derive stored timing for a payment line.
 * @returns {StoredPaymentTiming|"other"}
 */
export function derivePaymentTiming(payment, firstDispatchAtIso) {
  if (payment?.paymentStatus === "PENDING") {
    return firstDispatchAtIso ? "balance" : "advance";
  }
  if (isAdvancePayment(payment, firstDispatchAtIso)) return "advance";
  if (isBalancePayment(payment, firstDispatchAtIso)) return "balance";
  return "other";
}

/**
 * Resolve timing: prefer valid stored value, else derive.
 * @returns {StoredPaymentTiming|"other"}
 */
export function resolvePaymentTiming(payment, firstDispatchAtIso) {
  const stored = payment?.paymentTiming;
  if (stored === "advance" || stored === "balance") return stored;
  return derivePaymentTiming(payment, firstDispatchAtIso);
}

/**
 * Insights / legacy API: map balance → after_dispatch.
 * @param {StoredPaymentTiming|"other"} timing
 * @returns {ApiPaymentTiming}
 */
export function toApiPaymentTiming(timing) {
  if (timing === "balance") return "after_dispatch";
  if (timing === "advance") return "advance";
  return "other";
}

/**
 * @param {Record<string, unknown>} payment
 * @param {string|null} firstDispatchAtIso
 * @returns {ApiPaymentTiming}
 */
export function getPaymentTimingForApi(payment, firstDispatchAtIso) {
  return toApiPaymentTiming(resolvePaymentTiming(payment, firstDispatchAtIso));
}

/**
 * @param {string} typeToken lowercased filter token
 */
function normalizeTypeToken(typeToken) {
  const t = String(typeToken || "").toLowerCase();
  if (t === "after_dispatch" || t === "balance") return "balance";
  if (t === "advance") return "advance";
  return t;
}

/**
 * @param {Record<string, unknown>} payment
 * @param {string|null} firstDispatchAtIso
 * @param {string|string[]} types comma list or array from query
 */
export function paymentMatchesTypes(payment, firstDispatchAtIso, types) {
  const raw = Array.isArray(types)
    ? types
    : String(types || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  if (!raw.length) return true;
  const list = raw.map((t) => normalizeTypeToken(t));
  const resolved = resolvePaymentTiming(payment, firstDispatchAtIso);
  const normalized =
    resolved === "balance" ? "balance" : resolved === "advance" ? "advance" : "other";
  if (normalized === "other") return list.includes("other");
  return list.includes(normalized);
}

/**
 * Set payment.paymentTiming on a payment object from order context.
 * @param {Record<string, unknown>} payment
 * @param {Record<string, unknown>} order
 * @param {{ force?: boolean }} [opts]
 * @returns {StoredPaymentTiming|"other"}
 */
export function applyPaymentTimingToPayment(payment, order, opts = {}) {
  const iso = firstDispatchAtIso(getFirstDispatchAt(order));
  const stored = payment?.paymentTiming;
  if (
    !opts.force &&
    (stored === "advance" || stored === "balance")
  ) {
    return stored;
  }
  const timing = derivePaymentTiming(payment, iso);
  if (timing === "advance" || timing === "balance") {
    payment.paymentTiming = timing;
  }
  return timing;
}

/**
 * Ensure each payment line has a valid paymentTiming (or omit field). Safe before save / $push.
 * @param {Record<string, unknown>[]} payments
 * @param {Record<string, unknown>} [order]
 */
export function sanitizePaymentArrayForOrder(payments, order = {}) {
  if (!Array.isArray(payments)) return;
  for (const payment of payments) {
    if (!payment || typeof payment !== "object") continue;
    const timing = payment.paymentTiming;
    if (
      timing == null ||
      (timing !== "advance" && timing !== "balance")
    ) {
      delete payment.paymentTiming;
    }
    applyPaymentTimingToPayment(payment, order);
  }
}

/**
 * Strip null/invalid paymentTiming from findOneAndUpdate $set / $push payment payloads.
 * @param {Record<string, unknown>} update
 * @param {Record<string, unknown>} [order]
 */
export function patchPaymentUpdateOperation(update, order = {}) {
  if (!update || typeof update !== "object") return;
  const push = update.$push?.payment;
  if (push) {
    const items = push.$each ? push.$each : [push];
    sanitizePaymentArrayForOrder(items, order);
  }
  if (Array.isArray(update.$set?.payment)) {
    sanitizePaymentArrayForOrder(update.$set.payment, order);
  }
}
