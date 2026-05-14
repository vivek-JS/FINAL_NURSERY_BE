import crypto from "crypto";

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

const normalizePhone = (value = "") =>
  String(value || "")
    .trim()
    .replace(/\D/g, "");

const getSecret = () => String(process.env.AGRI_LOAD_LINK_SECRET || "").trim();

export const normalizePhoneForWhitelist = (value = "") => {
  const digits = normalizePhone(value);
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  return digits;
};

export const getAgriLoadWhitelist = () =>
  String(process.env.AGRI_LOAD_LINK_WHITELIST || "")
    .split(",")
    .map((n) => normalizePhoneForWhitelist(n))
    .filter(Boolean);

export const buildAgriLoadSignaturePayload = ({
  orderNumber = "",
  exp = 0,
  actorPhone = "",
}) => {
  const ord = String(orderNumber || "").trim().toUpperCase();
  const expires = Number(exp) || 0;
  const actor = normalizePhoneForWhitelist(actorPhone);
  return `${ord}|${expires}|${actor}`;
};

export const signAgriLoadPayload = (payload) => {
  const secret = getSecret();
  if (!secret) throw new Error("AGRI_LOAD_LINK_SECRET is not configured");
  return crypto.createHmac("sha256", secret).update(String(payload)).digest("hex");
};

export const createAgriLoadLinkToken = ({
  orderNumber = "",
  actorPhone = "",
  ttlSeconds = DEFAULT_TTL_SECONDS,
} = {}) => {
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = nowSec + Math.max(60, Number(ttlSeconds) || DEFAULT_TTL_SECONDS);
  const payload = buildAgriLoadSignaturePayload({ orderNumber, exp, actorPhone });
  const sig = signAgriLoadPayload(payload);
  return { exp, sig };
};

export const verifyAgriLoadLinkToken = ({
  orderNumber = "",
  exp = 0,
  actorPhone = "",
  sig = "",
}) => {
  const expires = Number(exp) || 0;
  if (!expires || Math.floor(Date.now() / 1000) > expires) {
    return { ok: false, reason: "expired" };
  }
  const provided = String(sig || "").trim().toLowerCase();
  if (!provided) return { ok: false, reason: "missing_signature" };

  const payload = buildAgriLoadSignaturePayload({ orderNumber, exp: expires, actorPhone });
  const expected = signAgriLoadPayload(payload).toLowerCase();
  if (expected.length !== provided.length) {
    return { ok: false, reason: "invalid_signature" };
  }
  const pass = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  return pass ? { ok: true } : { ok: false, reason: "invalid_signature" };
};

export const buildAgriLoadActionUrl = ({
  orderNumber = "",
  actorPhone = "",
  baseUrl = "",
  ttlSeconds,
}) => {
  const cleanBase =
    String(baseUrl || process.env.PUBLIC_ACTION_BASE_URL || process.env.API_BASE_URL || "")
      .trim()
      .replace(/\/+$/, "");
  if (!cleanBase) return "";

  const { exp, sig } = createAgriLoadLinkToken({ orderNumber, actorPhone, ttlSeconds });
  const params = new URLSearchParams({
    orderNumber: String(orderNumber || "").trim(),
    actorPhone: normalizePhoneForWhitelist(actorPhone),
    exp: String(exp),
    sig,
  });
  return `${cleanBase}/api/v1/agri-load-link/mark-loaded?${params.toString()}`;
};
