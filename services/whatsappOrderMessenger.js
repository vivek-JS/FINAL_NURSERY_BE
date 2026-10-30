/**
 * Outbound messages for WhatsApp order bot — scanned session ("webjs" channel) and/or WATI.
 */

import {
  isWhatsAppReady,
  reportWhatsAppTransportFailure,
  waitUntilWhatsAppReady,
  sendWhatsAppText,
} from "./whatsapp/index.js";
import {
  isWhatsappOrderWebJsEnabled,
  isWhatsappOrderWatiEnabled,
  isWhatsappOrderDualChannel,
} from "../utility/whatsappOrderFlowFlags.js";
import {
  getOrderReplyChannel,
  getWebJsChatJid,
} from "./whatsappOrderReplyChannel.js";
import { sendWebJsReply } from "./whatsappOrderWebReply.js";
import { sendSessionTextMessage } from "./watiService.js";

function indianMobileTarget(number) {
  const digits = String(number).replace(/\D/g, "");
  const ten = digits.slice(-10);
  return ten.length === 10 ? `91${ten}` : digits;
}

async function sendToTargets(targets, body) {
  let lastError = null;
  for (const target of targets) {
    try {
      const sent = await sendWhatsAppText(target, body);
      if (sent.ok) {
        console.log(`[WhatsApp Order] ✅ Sent to ${sent.jid}`);
        return { success: true, channel: "webjs", targetId: sent.jid };
      }
      lastError = sent.reason;
    } catch (err) {
      lastError = err?.message || String(err);
      console.warn(`[WhatsApp Order] Send to ${target} failed:`, lastError);
      if (reportWhatsAppTransportFailure(err, "order-send")) {
        return { success: false, error: lastError, connectionLost: true };
      }
    }
  }
  return { success: false, error: lastError || "send_failed" };
}

async function sendViaWebJs(phone, text) {
  const body = String(text ?? "").trim();
  if (!body) {
    return { success: false, error: "empty_message", channel: "webjs" };
  }

  if (!isWhatsappOrderWebJsEnabled()) {
    return { success: false, error: "webjs_disabled", channel: "webjs" };
  }
  if (!isWhatsAppReady) {
    console.warn("[WhatsApp Order] Client not ready — cannot reply to", phone);
    return { success: false, error: "not_ready", channel: "webjs" };
  }

  const directReply = await sendWebJsReply(phone, body);
  if (directReply?.success) {
    return { ...directReply, channel: "webjs" };
  }

  const targets = [...new Set([getWebJsChatJid(phone), indianMobileTarget(phone)].filter(Boolean))];
  let result = await sendToTargets(targets, body);

  if (result.connectionLost && (await waitUntilWhatsAppReady(60000))) {
    result = await sendToTargets(targets, body);
    if (result.success) result.retried = true;
  }

  if (result.success) return result;
  console.error("[WhatsApp Order] ❌ Scanned-session send failed:", result.error);
  return { success: false, error: result.error, channel: "webjs" };
}

function watiDigits(phone) {
  const d = String(phone).replace(/\D/g, "");
  if (d.length === 10) return `91${d}`;
  if (d.length === 12 && d.startsWith("91")) return d;
  return d.length >= 10 ? d : "";
}

async function sendViaWati(phone, text) {
  if (!isWhatsappOrderWatiEnabled()) {
    return { success: false, error: "wati_disabled", channel: "wati" };
  }

  const body = String(text ?? "").trim();
  if (!body) {
    return { success: false, error: "empty_message", channel: "wati" };
  }

  const digits = watiDigits(phone);
  if (!digits || digits.length < 12) {
    return { success: false, error: "invalid_phone", channel: "wati" };
  }

  try {
    await sendSessionTextMessage({ whatsappNumber: digits, messageText: body });
    console.log(`[WhatsApp Order] ✅ Sent (WATI session) to ${digits}`);
    return { success: true, channel: "wati" };
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("[WhatsApp Order] ❌ WATI session send failed:", msg);
    if (/empty|can not be empty/i.test(msg)) {
      console.error(
        "[WhatsApp Order] Farmer must message your WATI number first (24h session window)."
      );
    }
    return { success: false, error: msg, channel: "wati" };
  }
}

/**
 * Send order-bot reply on the channel the farmer last messaged on.
 * @param {string} phone
 * @param {string} text
 * @param {{ channel?: 'webjs' | 'wati' }} [opts]
 */
export async function sendOrderBotMessage(phone, text, opts = {}) {
  const body = String(text ?? "").trim();
  if (!body) {
    console.warn("[WhatsApp Order] Skipping send — empty message");
    return { success: false, error: "empty_message" };
  }

  const preferred =
    opts.channel || getOrderReplyChannel(phone, isWhatsappOrderWebJsEnabled() ? "webjs" : "wati");

  if (preferred === "wati") {
    const watiResult = await sendViaWati(phone, body);
    if (watiResult.success) return watiResult;
    const autoFallback =
      process.env.WHATSAPP_ORDER_FALLBACK_WEBJS === "true" ||
      (isWhatsappOrderDualChannel() &&
        process.env.WHATSAPP_ORDER_FALLBACK_WEBJS !== "false");
    if (isWhatsappOrderWebJsEnabled() && autoFallback) {
      console.warn("[WhatsApp Order] WATI failed, trying web.js fallback:", watiResult.error);
      return sendViaWebJs(phone, body);
    }
    return watiResult;
  }

  const webResult = await sendViaWebJs(phone, body);
  if (webResult.success) return webResult;
  if (isWhatsappOrderWatiEnabled() && process.env.WHATSAPP_ORDER_FALLBACK_WATI === "true") {
    console.warn("[WhatsApp Order] web.js failed, trying WATI fallback");
    return sendViaWati(phone, body);
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
