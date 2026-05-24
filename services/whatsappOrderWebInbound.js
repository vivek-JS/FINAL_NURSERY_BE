/**
 * Inbound WhatsApp messages on the scanned whatsapp-web.js session (order bot).
 */

import {
  isWhatsappOrderFlowDisabled,
  isWhatsappOrderWebJsEnabled,
} from "../utility/whatsappOrderFlowFlags.js";
import { normalizeWhatsAppMobile } from "./whatsappOrderFarmer.service.js";
import { setOrderReplyChannel } from "./whatsappOrderReplyChannel.js";

export async function handleWebJsInboundMessage(msg) {
  if (isWhatsappOrderFlowDisabled() || !isWhatsappOrderWebJsEnabled()) {
    return { handled: false, reason: "flow_disabled_or_webjs_off" };
  }

  if (!msg || msg.fromMe) {
    return { handled: false, reason: "from_me" };
  }

  if (msg.isStatus) {
    return { handled: false, reason: "status" };
  }

  if (msg.hasMedia && !String(msg.body || "").trim()) {
    return { handled: false, reason: "media_only" };
  }

  const text = String(msg.body || "").trim();
  if (!text) {
    return { handled: false, reason: "empty_body" };
  }

  const from = msg.from || "";
  if (from.endsWith("@g.us")) {
    return { handled: false, reason: "group" };
  }

  const chatMobile = normalizeWhatsAppMobile(from.split("@")[0]);
  if (!chatMobile) {
    return { handled: false, reason: "invalid_sender" };
  }

  const senderName =
    msg._data?.notifyName ||
    msg._data?.pushname ||
    (await msg.getContact?.()?.catch(() => null))?.pushname ||
    "";

  console.log(`\n📩 [WhatsApp Order / web.js] From ${chatMobile}: "${text.slice(0, 80)}"`);

  setOrderReplyChannel(chatMobile, "webjs");

  const { handleInboundOrderMessage } = await import(
    "../controllers/whatsappOrderBot.controller.js"
  );

  await handleInboundOrderMessage({
    chatMobile,
    text,
    senderName: senderName || "",
    channel: "webjs",
  });

  return { handled: true, chatMobile, channel: "webjs" };
}
