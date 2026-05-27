import crypto from "crypto";

const NONCE_TTL_MS = 10 * 60 * 1000;
const seenNonces = new Map();

function purgeExpiredNonces() {
  const now = Date.now();
  for (const [nonce, exp] of seenNonces.entries()) {
    if (exp <= now) seenNonces.delete(nonce);
  }
}

/**
 * Build signed request headers to prevent replay attacks.
 * Client must send: X-Request-Id, X-Request-Timestamp, X-Request-Signature
 */
export function buildSignedHeaders(body, secret) {
  if (!secret) {
    return {
      "X-Request-Id": crypto.randomUUID(),
      "X-Request-Timestamp": new Date().toISOString(),
    };
  }

  const requestId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const payload = `${requestId}|${timestamp}|${JSON.stringify(body || {})}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  return {
    "X-Request-Id": requestId,
    "X-Request-Timestamp": timestamp,
    "X-Request-Signature": signature,
  };
}

/**
 * Verify inbound webhook/callback signature and reject replays.
 */
export function verifySignedRequest(req, secret, maxSkewMs = 5 * 60 * 1000) {
  if (!secret) return { ok: true, skipped: true };

  const requestId = req.headers["x-request-id"];
  const timestamp = req.headers["x-request-timestamp"];
  const signature = req.headers["x-request-signature"];

  if (!requestId || !timestamp || !signature) {
    return { ok: false, reason: "MISSING_SIGNATURE_HEADERS" };
  }

  const ts = new Date(timestamp).getTime();
  if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > maxSkewMs) {
    return { ok: false, reason: "TIMESTAMP_SKEW" };
  }

  purgeExpiredNonces();
  if (seenNonces.has(requestId)) {
    return { ok: false, reason: "REPLAY_DETECTED" };
  }

  const payload = `${requestId}|${timestamp}|${JSON.stringify(req.body || {})}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  const valid = crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(String(signature), "hex")
  );

  if (!valid) return { ok: false, reason: "INVALID_SIGNATURE" };

  seenNonces.set(requestId, Date.now() + NONCE_TTL_MS);
  return { ok: true };
}
