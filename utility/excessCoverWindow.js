/** Default past lookback for excess cover (ready before delivery). */
export const EXCESS_COVER_PAST_DAYS = 12;
/** Legacy alias — same as EXCESS_COVER_PAST_DAYS. */
export const EXCESS_PAST_READY_DAYS = EXCESS_COVER_PAST_DAYS;

/**
 * Ready date vs delivery offset must sit in [-pastCap, +win].
 * Default booking window is −12 / +3 (pastCap=12, win=3).
 */
export function excessReadyInWindow(offsetDays, win, pastCap = win) {
  if (!Number.isFinite(offsetDays)) return false;
  const future = Math.max(0, Math.floor(Number(win) || 0));
  const past = Math.max(0, Math.floor(Number(pastCap ?? win) || 0));
  if (offsetDays > future) return false;
  if (offsetDays < -past) return false;
  return true;
}
