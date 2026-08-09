/**
 * Inbound WhatsApp scan: whitelisted admins can mark linked agri loads by replying.
 *
 * Examples:
 *   LOADED
 *   loaded AGR-20250802-001
 *   AGR-20250802-001 loaded
 *
 * Env:
 *   WHATSAPP_AGRI_LOAD_INBOUND_ENABLED=true  (default on unless "false")
 *   AGRI_LOAD_LINK_WHITELIST=9198...,9199...
 *   WHATSAPP_ADMIN_NUMBERS=...  (also allowed to send load commands)
 */

import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import {
  getAgriLoadWhitelist,
  normalizePhoneForWhitelist,
} from "../utils/agriLoadLinkSigner.js";
import { getAdminNumbersFromEnv, sendWhatsAppMessage } from "./whatsappAlertService.js";

const LOAD_KEYWORD = /\b(loaded|load done|mark loaded|लोड|लोडेड)\b/i;
const AGRI_ORDER_RE = /\b(AGR-\d{6,8}-\d+)\b/gi;

function isAgriLoadInboundEnabled() {
  return process.env.WHATSAPP_AGRI_LOAD_INBOUND_ENABLED !== "false";
}

function buildInboundWhitelist() {
  const set = new Set(getAgriLoadWhitelist());
  for (const adminId of getAdminNumbersFromEnv()) {
    const digits = normalizePhoneForWhitelist(String(adminId).split("@")[0]);
    if (digits) set.add(digits);
  }
  return set;
}

async function resolveSenderMobile(msg) {
  const from = msg?.from || "";
  const direct = normalizePhoneForWhitelist(from.split("@")[0]);
  if (direct) return direct;

  try {
    const contact = await msg.getContact();
    const fromContact =
      normalizePhoneForWhitelist(contact?.number) ||
      normalizePhoneForWhitelist(contact?.id?.user);
    if (fromContact) return fromContact;
  } catch {
    /* ignore */
  }

  try {
    const chat = await msg.getChat();
    const fromChat =
      normalizePhoneForWhitelist(chat?.id?.user) ||
      normalizePhoneForWhitelist(String(chat?.id || "").split("@")[0]);
    if (fromChat) return fromChat;
  } catch {
    /* ignore */
  }

  return null;
}

function extractAgriOrderNumbers(text) {
  const found = new Set();
  for (const match of String(text || "").matchAll(AGRI_ORDER_RE)) {
    found.add(String(match[1]).trim().toUpperCase());
  }
  return [...found];
}

async function replyToSender(chatJid, senderPhone, lines) {
  const text = lines.filter(Boolean).join("\n");
  if (!text) return;
  const target = chatJid || senderPhone;
  await sendWhatsAppMessage(target, text);
}

/**
 * @returns {Promise<{ handled: boolean, reason?: string, marked?: string[] }>}
 */
export async function handleAgriLoadInboundMessage(msg) {
  if (!isAgriLoadInboundEnabled()) {
    return { handled: false, reason: "inbound_disabled" };
  }
  if (!msg || msg.fromMe) {
    return { handled: false, reason: "from_me" };
  }
  if (msg.isStatus) {
    return { handled: false, reason: "status" };
  }

  const from = msg.from || "";
  if (from.endsWith("@g.us")) {
    return { handled: false, reason: "group" };
  }

  const text = String(msg.body || "").trim();
  if (!text) {
    return { handled: false, reason: "empty_body" };
  }

  const senderPhone = await resolveSenderMobile(msg);
  if (!senderPhone) {
    return { handled: false, reason: "invalid_sender" };
  }

  const whitelist = buildInboundWhitelist();
  if (!whitelist.has(senderPhone)) {
    return { handled: false, reason: "not_whitelisted" };
  }

  const orderNumbers = extractAgriOrderNumbers(text);
  const hasLoadKeyword = LOAD_KEYWORD.test(text);
  if (!hasLoadKeyword && orderNumbers.length === 0) {
    return { handled: false, reason: "not_load_command" };
  }

  console.log(
    `\n📩 [WhatsApp Agri Load] From ${senderPhone} (${from}): "${text.slice(0, 120)}"`
  );

  const { confirmAgriLoadViaLink, notifyAdminsAgriLoadConfirmed } = await import(
    "./agriLoadLink.service.js"
  );

  const marked = [];
  const already = [];

  if (orderNumbers.length > 0) {
    for (const orderNumber of orderNumbers) {
      try {
        const summary = await confirmAgriLoadViaLink({
          orderRef: orderNumber,
          actorPhone: senderPhone,
        });
        marked.push(...(summary.marked || []));
        already.push(...(summary.alreadyLoaded || []));
        await notifyAdminsAgriLoadConfirmed(summary);
      } catch (err) {
        if (err.statusCode === 404) continue;
        throw err;
      }
    }
  } else if (hasLoadKeyword) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const pending = await AgriSalesOrder.find({
      linkedNurseryOrderId: { $ne: null },
      agriLoadStatus: { $ne: "LOADED" },
      orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
      orderDate: { $gte: start, $lte: end },
    }).limit(20);
    for (const row of pending) {
      try {
        const summary = await confirmAgriLoadViaLink({
          orderRef: row.orderNumber,
          actorPhone: senderPhone,
        });
        marked.push(...(summary.marked || []));
        already.push(...(summary.alreadyLoaded || []));
        await notifyAdminsAgriLoadConfirmed(summary);
      } catch {
        /* skip individual */
      }
    }
  }

  if (marked.length > 0) {
    await replyToSender(from, senderPhone, [
      `✅ Marked LOADED: ${marked.join(", ")}`,
      "Nursery DC will generate when shed load is complete.",
    ]);
  } else if (already.length > 0) {
    await replyToSender(from, senderPhone, [`Already LOADED: ${already.join(", ")}`]);
  } else if (hasLoadKeyword) {
    await replyToSender(from, senderPhone, ["No pending linked agri loads found for today."]);
  }

  return {
    handled: true,
    marked,
    alreadyLoaded: already,
  };
}
