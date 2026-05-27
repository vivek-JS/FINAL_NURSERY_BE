import crypto from "crypto";

const seenKeys = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;

function purge() {
  const now = Date.now();
  for (const [k, exp] of seenKeys.entries()) {
    if (exp <= now) seenKeys.delete(k);
  }
}

/**
 * Idempotency via X-Idempotency-Key header.
 * Returns 409 if same key was used within 24h.
 */
export function idempotencyMiddleware(req, res, next) {
  const key = req.headers["x-idempotency-key"];
  if (!key) return next();

  purge();
  const hash = crypto.createHash("sha256").update(`${req.method}|${req.path}|${key}`).digest("hex");

  if (seenKeys.has(hash)) {
    return res.status(409).json({
      success: false,
      message: "Duplicate request — idempotency key already processed",
      code: "IDEMPOTENCY_CONFLICT",
    });
  }

  seenKeys.set(hash, Date.now() + TTL_MS);
  return next();
}
