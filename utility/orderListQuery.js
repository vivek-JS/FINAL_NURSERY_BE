/**
 * Shared helpers for GET /order/getOrders status + date-range filtering.
 */

/** Pre-dispatch pipeline statuses for needsDispatch=true. */
export const NEEDS_DISPATCH_STATUSES = [
  "PENDING",
  "ACCEPTED",
  "ASSIGNED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
];

/**
 * @param {string|string[]|undefined|null} statusRaw Express query value (comma-separated or repeated keys).
 * @returns {string[]} Uppercase, trimmed, unique status tokens.
 */
export function parseOrderStatusList(statusRaw) {
  if (statusRaw == null || statusRaw === "") return [];
  const raw = Array.isArray(statusRaw)
    ? statusRaw.flatMap((s) => String(s).split(","))
    : String(statusRaw).split(",");
  const seen = new Set();
  const out = [];
  for (const part of raw) {
    const token = String(part).trim().toUpperCase();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  if (out.includes("ACCEPTED") && !out.includes("ASSIGNED")) {
    out.push("ASSIGNED");
  }
  return out;
}

/**
 * Resolve status list when needsDispatch=true (overrides explicit status).
 * @param {boolean} needsDispatchFlag
 * @param {string|string[]|undefined|null} statusRaw
 */
export function resolveOrderStatusTokens(needsDispatchFlag, statusRaw) {
  if (String(needsDispatchFlag) === "true") {
    return [...NEEDS_DISPATCH_STATUSES];
  }
  return parseOrderStatusList(statusRaw);
}

/**
 * Build a single $match for orderStatus (+ optional booking/delivery date window).
 * When a date window is provided, every status in the list is constrained by that field.
 *
 * @param {string[]} statusTokensUpper
 * @param {{ field: string, start: Date, end: Date }|null} dateWindow
 * @returns {object|null} Mongo $match stage body, or null if no status filter.
 */
export function buildOrderStatusDateMatch(statusTokensUpper, dateWindow) {
  if (!statusTokensUpper.length) return null;

  if (!dateWindow) {
    return { orderStatus: { $in: statusTokensUpper } };
  }

  const { field, start, end } = dateWindow;
  return {
    orderStatus: { $in: statusTokensUpper },
    [field]: { $gte: start, $lte: end },
  };
}
