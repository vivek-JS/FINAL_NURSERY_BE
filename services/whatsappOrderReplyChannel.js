/**
 * Remember which channel (web.js vs WATI) each farmer last used so replies match.
 */

import { normalizeWhatsAppMobile } from "./whatsappOrderFarmer.service.js";

/** @typedef {'webjs' | 'wati'} OrderReplyChannel */

const lastChannelByMobile = new Map();

function key(mobile) {
  return normalizeWhatsAppMobile(mobile) || String(mobile).replace(/\D/g, "").slice(-10);
}

/** @param {string} mobile @param {OrderReplyChannel} channel */
export function setOrderReplyChannel(mobile, channel) {
  const k = key(mobile);
  if (!k || (channel !== "webjs" && channel !== "wati")) return;
  lastChannelByMobile.set(k, channel);
}

/** @param {string} mobile @param {OrderReplyChannel} [fallback='webjs'] */
export function getOrderReplyChannel(mobile, fallback = "webjs") {
  const k = key(mobile);
  if (!k) return fallback;
  return lastChannelByMobile.get(k) || fallback;
}

export function clearOrderReplyChannel(mobile) {
  const k = key(mobile);
  if (k) lastChannelByMobile.delete(k);
}
