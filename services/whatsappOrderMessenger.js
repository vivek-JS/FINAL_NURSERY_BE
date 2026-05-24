/**
 * Outbound messages for WhatsApp order bot — web.js and/or WATI (dual channel).
 */

import {
  getWhatsAppClient,
  isWhatsAppReady,
} from "./whatsappClient.js";
import {
  isWhatsappOrderWebJsEnabled,
  isWhatsappOrderWatiEnabled,
  isWhatsappOrderDualChannel,
} from "../utility/whatsappOrderFlowFlags.js";
import { getOrderReplyChannel } from "./whatsappOrderReplyChannel.js";

function formatChatId(number) {
  const digits = String(number).replace(/\D/g, "");
  const ten =
    digits.length >= 12 && digits.startsWith("91")
      ? digits.slice(-10)
      : digits.length === 10
        ? digits
        : digits.slice(-10);
  if (!ten || ten.length !== 10) return `${digits}@c.us`;
  return `91${ten}@c.us`;
}

async function resolveChatId(wa, number) {
  const digits = String(number).replace(/\D/g, "");
  const lookup =
    digits.length === 10 ? `91${digits}` : digits.startsWith("91") ? digits : `91${digits.slice(-10)}`;
  const fallback = formatChatId(number);
  try {
    const registered = await wa.getNumberId(lookup);
    if (registered?._serialized) return registered._serialized;
  } catch (err) {
    console.warn("[WhatsApp Order] getNumberId failed:", err?.message || err);
  }
  return fallback;
}

async function sendViaWebJs(phone, text) {
  if (!isWhatsappOrderWebJsEnabled()) {
    return { success: false, error: "webjs_disabled", channel: "webjs" };
  }
  if (!isWhatsAppReady) {
    console.warn("[WhatsApp Order] Client not ready — cannot reply to", phone);
    return { success: false, error: "not_ready", channel: "webjs" };
  }
  const wa = getWhatsAppClient();
  if (!wa) {
    return { success: false, error: "no_client", channel: "webjs" };
  }
  try {
    const targetId = await resolveChatId(wa, phone);
    await wa.sendMessage(targetId, text);
    console.log(`[WhatsApp Order] ✅ Sent (web.js) to ${targetId}`);
    return { success: true, channel: "webjs" };
  } catch (err) {
    console.error("[WhatsApp Order] ❌ web.js send failed:", err?.message || err);
    return { success: false, error: err?.message || String(err), channel: "webjs" };
  }
}

async function sendViaWati(phone, text) {
  if (!isWhatsappOrderWatiEnabled()) {
    return { success: false, error: "wati_disabled", channel: "wati" };
  }
  const { sendOrderBotMessageWati } = await import(
    "../controllers/whatsappOrderBot.controller.js"
  );
  const result = await sendOrderBotMessageWati(phone, text);
  return { ...result, channel: "wati" };
}

/**
 * Send order-bot reply on the channel the farmer last messaged on.
 * @param {string} phone
 * @param {string} text
 * @param {{ channel?: 'webjs' | 'wati' }} [opts]
 */
export async function sendOrderBotMessage(phone, text, opts = {}) {
  const preferred =
    opts.channel || getOrderReplyChannel(phone, isWhatsappOrderWebJsEnabled() ? "webjs" : "wati");

  if (preferred === "wati") {
    const watiResult = await sendViaWati(phone, text);
    if (watiResult.success) return watiResult;
    if (isWhatsappOrderWebJsEnabled() && process.env.WHATSAPP_ORDER_FALLBACK_WEBJS === "true") {
      console.warn("[WhatsApp Order] WATI failed, trying web.js fallback");
      return sendViaWebJs(phone, text);
    }
    return watiResult;
  }

  const webResult = await sendViaWebJs(phone, text);
  if (webResult.success) return webResult;
  if (isWhatsappOrderWatiEnabled() && process.env.WHATSAPP_ORDER_FALLBACK_WATI === "true") {
    console.warn("[WhatsApp Order] web.js failed, trying WATI fallback");
    return sendViaWati(phone, text);
  }
  return webResult;
}

export function getOrderBotChannel() {
  if (isWhatsappOrderDualChannel()) return "dual";
  if (isWhatsappOrderWebJsEnabled()) return "webjs";
  if (isWhatsappOrderWatiEnabled()) return "wati";
  return "none";
}

export function getOrderBotChannels() {
  return {
    mode: getOrderBotChannel(),
    webjs: isWhatsappOrderWebJsEnabled(),
    wati: isWhatsappOrderWatiEnabled(),
  };
}
