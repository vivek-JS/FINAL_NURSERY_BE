/**
 * Cooldown dedupe for WhatsApp alert engine — avoids repeating the same alert.
 * In-memory (single Node process). Tune with WHATSAPP_ALERT_COOLDOWN_MS.
 */

const COOLDOWN_MS = parseInt(
  process.env.WHATSAPP_ALERT_COOLDOWN_MS || String(6 * 60 * 60 * 1000),
  10
);

/** @type {Map<string, number>} */
const sentAt = new Map();

function prune(now) {
  for (const [k, t] of sentAt.entries()) {
    if (now - t > COOLDOWN_MS) {
      sentAt.delete(k);
    }
  }
}

/**
 * @param {string} key - Stable alert id, e.g. `big-order:123`, `slot-low:abc`
 * @returns {boolean} true if alert should be skipped (recently sent)
 */
export function shouldSkipAlert(key) {
  if (!key) return false;
  const now = Date.now();
  prune(now);
  return sentAt.has(key);
}

/** Call after a successful admin notification. */
export function markAlertSent(key) {
  if (!key) return;
  sentAt.set(key, Date.now());
}

export function getAlertCooldownMs() {
  return COOLDOWN_MS;
}

/** Test helper */
export function clearAlertDedupeForTests() {
  sentAt.clear();
}
