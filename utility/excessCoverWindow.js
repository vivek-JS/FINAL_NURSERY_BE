const intDays = (value, fallback = 0) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Already-ready excess can be older than the forward sowing cover window. */
export const EXCESS_PAST_READY_DAYS = 45;

/**
 * True when a sowing batch ready-date offset can cover an order.
 * Negative offsets are already-ready stock; positive offsets become ready after delivery.
 */
export function excessReadyInWindow(offsetDays, forwardDays, pastDays = EXCESS_PAST_READY_DAYS) {
  const offset = Math.floor(Number(offsetDays));
  if (!Number.isFinite(offset)) return false;
  const forward = intDays(forwardDays);
  const past = intDays(pastDays, EXCESS_PAST_READY_DAYS);
  return offset >= -past && offset <= forward;
}
