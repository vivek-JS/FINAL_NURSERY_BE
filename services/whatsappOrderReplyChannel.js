/**
 * Per-farmer reply routing: channel (web.js vs WATI) + web.js chat JID (@lid / @c.us).
 */

import { normalizeWhatsAppMobile } from "./whatsappOrderFarmer.service.js";

/** @typedef {'webjs' | 'wati'} OrderReplyChannel */

const lastChannelByMobile = new Map();
/** @type {Map<string, string>} last10 -> full msg.from (e.g. xxx@lid) */
const webJsChatJidByMobile = new Map();

function key(mobile) {
  return normalizeWhatsAppMobile(mobile) || String(mobile).replace(/\D/g, "").slice(-10);
}

/** @param {string} mobile @param {OrderReplyChannel} channel */
export function setOrderReplyChannel(mobile, channel) {
  const k = key(mobile);
  if (!k || (channel !== "webjs" && channel !== "wati")) return;
  lastChannelByMobile.set(k, channel);
}

/** Store WhatsApp JID from inbound web.js message (required for @lid users). */
export function setWebJsChatJid(mobile, chatJid) {
  const k = key(mobile);
  const jid = String(chatJid || "").trim();
  if (!k || !jid || !jid.includes("@")) return;
  webJsChatJidByMobile.set(k, jid);
}

export function getWebJsChatJid(mobile) {
  const k = key(mobile);
  if (!k) return null;
  return webJsChatJidByMobile.get(k) || null;
}

/** @param {string} mobile @param {OrderReplyChannel} [fallback='webjs'] */
export function getOrderReplyChannel(mobile, fallback = "webjs") {
  const k = key(mobile);
  if (!k) return fallback;
  return lastChannelByMobile.get(k) || fallback;
}

export function clearOrderReplyChannel(mobile) {
  const k = key(mobile);
  if (!k) return;
  lastChannelByMobile.delete(k);
  webJsChatJidByMobile.delete(k);
}
