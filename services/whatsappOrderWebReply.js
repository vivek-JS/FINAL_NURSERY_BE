/**
 * Reply on the same whatsapp-web.js chat using msg.reply() — fixes "No LID for user".
 */

import { normalizeWhatsAppMobile } from "./whatsappOrderFarmer.service.js";

const TTL_MS = 30 * 60 * 1000;
/** @type {Map<string, { msg: object, at: number }>} */
const lastInboundByMobile = new Map();

function mobileKey(mobile) {
  return normalizeWhatsAppMobile(mobile) || String(mobile).replace(/\D/g, "").slice(-10);
}

function prune() {
  const now = Date.now();
  for (const [k, v] of lastInboundByMobile) {
    if (now - v.at > TTL_MS) lastInboundByMobile.delete(k);
  }
}

export function registerWebJsInboundMessage(mobile, msg) {
  const k = mobileKey(mobile);
  if (!k || !msg) return;
  lastInboundByMobile.set(k, { msg, at: Date.now() });
}

export function clearWebJsInboundMessage(mobile) {
  const k = mobileKey(mobile);
  if (k) lastInboundByMobile.delete(k);
}

/**
 * @returns {Promise<{ success: boolean, method?: string, error?: string } | null>}
 */
export async function sendWebJsReply(mobile, text) {
  const body = String(text ?? "").trim();
  if (!body) {
    return { success: false, error: "empty_message" };
  }

  prune();
  const entry = lastInboundByMobile.get(mobileKey(mobile));
  if (!entry?.msg) {
    return null;
  }

  const { msg } = entry;

  if (typeof msg.reply === "function") {
    try {
      await msg.reply(body);
      console.log("[WhatsApp Order] ✅ Sent via msg.reply()");
      return { success: true, method: "reply" };
    } catch (err) {
      console.warn("[WhatsApp Order] msg.reply failed:", err?.message || err);
    }
  }

  try {
    const chat = await msg.getChat();
    if (chat && typeof chat.sendMessage === "function") {
      await chat.sendMessage(body);
      console.log("[WhatsApp Order] ✅ Sent via chat.sendMessage()");
      return { success: true, method: "chat" };
    }
  } catch (err) {
    console.warn("[WhatsApp Order] chat.sendMessage failed:", err?.message || err);
  }

  return { success: false, error: "reply_and_chat_failed" };
}
