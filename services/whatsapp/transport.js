/**
 * Outbound sends on the linked WhatsApp session.
 * Targets accepted: 10-digit / 91-prefixed numbers, "…@c.us" (legacy), "…@s.whatsapp.net", "…@lid".
 */
import { isLidUser } from "baileys";
import { getActiveSocket, isWhatsAppReady, rememberSentMessage } from "./connection.js";

const JID_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const JID_CACHE_MAX = 2000;
/** digits -> { jid, exists, at } — avoids a USync round-trip on every alert. */
const jidCache = new Map();

export function toUserJid(target) {
  const raw = String(target ?? "").trim();
  if (raw.includes("@")) {
    const [user, server] = raw.split("@");
    if (server === "c.us") return `${user.split(":")[0]}@s.whatsapp.net`;
    return raw;
  }
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return `${digits.length === 10 ? `91${digits}` : digits}@s.whatsapp.net`;
}

function cacheJid(digits, entry) {
  jidCache.set(digits, { ...entry, at: Date.now() });
  if (jidCache.size > JID_CACHE_MAX) jidCache.delete(jidCache.keys().next().value);
}

/** @returns {Promise<{ jid: string, exists: boolean | null }>} exists=null when lookup was skipped/failed */
export async function resolveWhatsAppJid(target) {
  const jid = toUserJid(target);
  if (!jid || isLidUser(jid) || !jid.endsWith("@s.whatsapp.net")) return { jid, exists: null };

  const digits = jid.split("@")[0];
  const cached = jidCache.get(digits);
  if (cached && Date.now() - cached.at < JID_CACHE_TTL_MS) return cached;

  const socket = getActiveSocket();
  if (!socket || !isWhatsAppReady) return { jid, exists: null };
  try {
    const [hit] = (await socket.onWhatsApp(digits)) || [];
    const entry = hit ? { jid: hit.jid || jid, exists: Boolean(hit.exists) } : { jid, exists: false };
    cacheJid(digits, entry);
    return entry;
  } catch {
    return { jid, exists: null };
  }
}

function requireSocket() {
  const socket = getActiveSocket();
  return isWhatsAppReady && socket ? socket : null;
}

function buildMediaContent({ buffer, mimetype, fileName, caption }) {
  const mime = mimetype || "application/octet-stream";
  if (mime.startsWith("image/")) return { image: buffer, mimetype: mime, caption };
  if (mime.startsWith("video/")) return { video: buffer, mimetype: mime, caption };
  if (mime.startsWith("audio/")) return { audio: buffer, mimetype: mime };
  return { document: buffer, mimetype: mime, fileName: fileName || "file", caption };
}

async function send(target, content, options) {
  const socket = requireSocket();
  if (!socket) return { ok: false, reason: "not_ready", jid: toUserJid(target) };

  const { jid, exists } = await resolveWhatsAppJid(target);
  if (!jid) return { ok: false, reason: "invalid_number", jid };
  if (exists === false) return { ok: false, reason: "not_on_whatsapp", jid };

  const sent = await socket.sendMessage(jid, content, options);
  rememberSentMessage(sent);
  return { ok: true, jid, messageId: sent?.key?.id || null };
}

/** Throws on transport errors (callers decide on retry); returns ok:false for expected cases. */
export function sendWhatsAppText(target, text, { quoted } = {}) {
  const body = String(text ?? "").trim();
  if (!body) return Promise.resolve({ ok: false, reason: "empty_message", jid: toUserJid(target) });
  return send(target, { text: body }, quoted ? { quoted } : undefined);
}

export function sendWhatsAppMedia(target, media) {
  if (!media?.buffer) return Promise.resolve({ ok: false, reason: "empty_media", jid: toUserJid(target) });
  return send(target, buildMediaContent(media));
}

export async function isWhatsAppNumberRegistered(target) {
  const { exists } = await resolveWhatsAppJid(target);
  return exists !== false;
}
