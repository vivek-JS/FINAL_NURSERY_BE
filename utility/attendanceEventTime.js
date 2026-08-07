export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Maximum age accepted for an offline-captured attendance event (guards against replay of stale queues). */
const MAX_BACKDATE_MS = 7 * 24 * 60 * 60 * 1000;
/** Tolerance for a client clock running slightly ahead of the server. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** IST calendar day (YYYY-MM-DD) for an instant, without pulling in a date library. */
export function toIstYmd(date) {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const month = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const day = String(ist.getUTCDate()).padStart(2, "0");
  return `${ist.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Resolves the instant an attendance event actually happened.
 *
 * Online requests use server time. Offline-synced requests pass the original
 * `capturedAt` so an entry queued at 9:15 AM and uploaded at 6 PM is still stored
 * on the right day with the right late flag. Values that are unparseable, in the
 * future, or older than a week fall back to server time rather than being trusted.
 */
export function resolveEventTime(capturedAt, now = new Date()) {
  if (!capturedAt) return { time: now, usedCapturedAt: false };

  const parsed = new Date(capturedAt);
  if (Number.isNaN(parsed.getTime())) return { time: now, usedCapturedAt: false };

  const age = now.getTime() - parsed.getTime();
  if (age < -MAX_CLOCK_SKEW_MS || age > MAX_BACKDATE_MS) return { time: now, usedCapturedAt: false };

  // A tiny amount of skew ahead of the server is clamped rather than rejected.
  return { time: age < 0 ? now : parsed, usedCapturedAt: age >= 0 };
}
