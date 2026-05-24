/**
 * Inbound WhatsApp messages on the scanned whatsapp-web.js session (order bot).
 */

import {
  isWhatsappOrderFlowDisabled,
  isWhatsappOrderWebJsEnabled,
} from "../utility/whatsappOrderFlowFlags.js";
import { shouldAcceptOrderMessage } from "../utility/whatsappOrderAcceptance.js";
import { normalizeWhatsAppMobile } from "./whatsappOrderFarmer.service.js";
import { setOrderReplyChannel, setWebJsChatJid } from "./whatsappOrderReplyChannel.js";
import { registerWebJsInboundMessage } from "./whatsappOrderWebReply.js";

async function resolveSenderMobile(msg) {
  const from = msg?.from || "";
  const direct = normalizeWhatsAppMobile(from.split("@")[0]);
  if (direct) return direct;

  try {
    const contact = await msg.getContact();
    const fromContact =
      normalizeWhatsAppMobile(contact?.number) ||
      normalizeWhatsAppMobile(contact?.id?.user);
    if (fromContact) return fromContact;
  } catch {
    /* ignore */
  }

  try {
    const chat = await msg.getChat();
    const fromChat =
      normalizeWhatsAppMobile(chat?.id?.user) ||
      normalizeWhatsAppMobile(String(chat?.id || "").split("@")[0]);
    if (fromChat) return fromChat;
  } catch {
    /* ignore */
  }

  return null;
}

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

  const chatMobile = await resolveSenderMobile(msg);
  if (!chatMobile) {
    console.warn("[WhatsApp Order / web.js] Could not resolve sender from", from);
    return { handled: false, reason: "invalid_sender" };
  }

  setOrderReplyChannel(chatMobile, "webjs");
  if (from) {
    setWebJsChatJid(chatMobile, from);
  }
  registerWebJsInboundMessage(chatMobile, msg);

  const { getOrderConversationStep, handleInboundOrderMessage } = await import(
    "../controllers/whatsappOrderBot.controller.js"
  );

  const step = getOrderConversationStep(chatMobile);
  if (!shouldAcceptOrderMessage(text, step)) {
    return { handled: false, reason: "not_order_message", chatMobile };
  }

  const senderName =
    msg._data?.notifyName ||
    msg._data?.pushname ||
    (await msg.getContact?.()?.catch(() => null))?.pushname ||
    "";

  console.log(`\n📩 [WhatsApp Order / web.js] From ${chatMobile} (${from}): "${text.slice(0, 80)}"`);

  await handleInboundOrderMessage({
    chatMobile,
    text,
    senderName: senderName || "",
    channel: "webjs",
  });

  return { handled: true, chatMobile, channel: "webjs" };
}
