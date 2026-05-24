/**
 * Outbound messages for WhatsApp order bot — web.js (QR session) or WATI.
 */

import {
  getWhatsAppClient,
  isWhatsAppReady,
} from "./whatsappClient.js";
import { isWhatsappOrderViaWebJs } from "../utility/whatsappOrderFlowFlags.js";

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
  if (!isWhatsAppReady) {
    console.warn("[WhatsApp Order] Client not ready — cannot reply to", phone);
    return { success: false, error: "not_ready" };
  }
  const wa = getWhatsAppClient();
  if (!wa) {
    return { success: false, error: "no_client" };
  }
  try {
    const targetId = await resolveChatId(wa, phone);
    await wa.sendMessage(targetId, text);
    console.log(`[WhatsApp Order] ✅ Sent (web.js) to ${targetId}`);
    return { success: true, channel: "webjs" };
  } catch (err) {
    console.error("[WhatsApp Order] ❌ web.js send failed:", err?.message || err);
    return { success: false, error: err?.message || String(err) };
  }
}

async function sendViaWati(phone, text) {
  const { sendOrderBotMessageWati } = await import(
    "../controllers/whatsappOrderBot.controller.js"
  );
  return sendOrderBotMessageWati(phone, text);
}

/** Send order-bot reply to user (10-digit or 91… mobile). */
export async function sendOrderBotMessage(phone, text) {
  if (isWhatsappOrderViaWebJs()) {
    return sendViaWebJs(phone, text);
  }
  return sendViaWati(phone, text);
}

export function getOrderBotChannel() {
  return isWhatsappOrderViaWebJs() ? "webjs" : "wati";
}
