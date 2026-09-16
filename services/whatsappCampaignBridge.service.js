/**
 * Campaign sends + delivery ACKs via the single ERP whatsapp-web.js client (erp-alert-bot).
 * Updates collections created by whatsapp-automation (same MongoDB).
 */
import fs from "fs";
import mongoose from "mongoose";
import pkg from "whatsapp-web.js";
import {
  getWhatsAppClient,
  isWhatsAppReady,
  getWhatsAppLinkedPhone,
} from "./whatsappClient.js";
import { reportWhatsAppTransportFailure } from "./whatsappClient.js";

const { MessageMedia } = pkg;

const ACK_RANK = {
  pending: 0,
  queued: 1,
  failed: 2,
  sent: 3,
  delivered: 4,
  read: 5,
  played: 6,
};

function ackToStatus(ack) {
  switch (ack) {
    case -1:
      return "failed";
    case 0:
      return "pending";
    case 1:
      return "sent";
    case 2:
      return "delivered";
    case 3:
      return "read";
    case 4:
      return "played";
    default:
      return "pending";
  }
}

function shouldUpdateStatus(current, next) {
  const cur = ACK_RANK[current] ?? 0;
  const nxt = ACK_RANK[next] ?? 0;
  if (next === "failed") {
    return current !== "read" && current !== "played" && current !== "delivered";
  }
  return nxt > cur;
}

function recipientsCol() {
  return mongoose.connection.collection("campaignrecipients");
}

function campaignsCol() {
  return mongoose.connection.collection("campaigns");
}

function statusEventsCol() {
  return mongoose.connection.collection("messagestatusevents");
}

function incomingCol() {
  return mongoose.connection.collection("incomingmessages");
}

const OUTBOUND_OK = new Set(["sent", "delivered", "read", "played"]);
const DELIVERED_OK = new Set(["delivered", "read", "played"]);
const READ_OK = new Set(["read", "played"]);

function computeCampaignStats(recipients) {
  const stats = {
    total: recipients.length,
    pending: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    replied: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  };
  for (const r of recipients) {
    const s = r.status || "pending";
    if (s === "pending" || s === "queued") stats.pending += 1;
    else if (s === "skipped") stats.skipped += 1;
    else if (s === "failed") stats.failed += 1;
    else if (s === "cancelled") stats.cancelled += 1;
    else if (OUTBOUND_OK.has(s)) {
      stats.sent += 1;
      if (DELIVERED_OK.has(s)) stats.delivered += 1;
      if (READ_OK.has(s)) stats.read += 1;
    }
    if (r.replied) stats.replied += 1;
  }
  return stats;
}

async function notifyCampaignApiEvent(payload) {
  const base = process.env.WA_CAMPAIGN_API_URL || "http://127.0.0.1:8100";
  const key = process.env.WA_CAMPAIGN_INTERNAL_KEY || "";
  if (!key) return;
  try {
    const axios = (await import("axios")).default;
    await axios.post(`${base}/api/internal/campaign-recipient-event`, payload, {
      headers: { "X-WA-Campaign-Key": key },
      timeout: 5000,
    });
  } catch {
    /* UI will poll */
  }
}

async function refreshCampaignStats(campaignId) {
  const recipients = await recipientsCol().find({ campaignId }).toArray();
  const stats = computeCampaignStats(recipients);
  await campaignsCol().updateOne({ _id: campaignId }, { $set: { stats } });
  return stats;
}

export async function sendCampaignOutbound({
  mobile,
  text,
  attachmentPath,
  attachmentMime,
}) {
  if (!isWhatsAppReady) {
    return { ok: false, reason: "not_ready" };
  }
  const wa = getWhatsAppClient();
  if (!wa) return { ok: false, reason: "no_client" };

  const digits = String(mobile).replace(/\D/g, "");
  const chatId = digits.includes("@") ? digits : `${digits}@c.us`;

  try {
    let sent;
    if (attachmentPath && fs.existsSync(attachmentPath)) {
      const buffer = fs.readFileSync(attachmentPath);
      const mime = attachmentMime || "application/octet-stream";
      const media = new MessageMedia(
        mime,
        buffer.toString("base64"),
        attachmentPath.split("/").pop() || "file"
      );
      sent = await wa.sendMessage(chatId, media, { caption: text || undefined });
    } else {
      sent = await wa.sendMessage(chatId, text || "");
    }
    return {
      ok: true,
      messageId: sent?.id?._serialized || null,
      chatId,
    };
  } catch (err) {
    reportWhatsAppTransportFailure(err, "campaign-send");
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function checkWhatsAppRegistered(mobile) {
  if (!isWhatsAppReady) return { ok: false, registered: false, reason: "not_ready" };
  const wa = getWhatsAppClient();
  if (!wa) return { ok: false, registered: false, reason: "no_client" };
  const digits = String(mobile).replace(/\D/g, "");
  const chatId = `${digits}@c.us`;
  try {
    const registered = await wa.isRegisteredUser(chatId);
    return { ok: true, registered: Boolean(registered) };
  } catch {
    return { ok: true, registered: true };
  }
}

export async function handleCampaignMessageAck(msg, ack) {
  const waId = msg?.id?._serialized;
  if (!waId) return;

  const nextStatus = ackToStatus(ack);
  const recipient = await recipientsCol().findOne({ whatsappMessageId: waId });
  if (!recipient) return;

  const current = recipient.status || "pending";
  if (!shouldUpdateStatus(current, nextStatus)) return;

  const now = new Date();
  const updates = { status: nextStatus };
  if (nextStatus === "sent") updates.sentAt = recipient.sentAt || now;
  if (nextStatus === "delivered") updates.deliveredAt = recipient.deliveredAt || now;
  if (nextStatus === "read" || nextStatus === "played") updates.readAt = recipient.readAt || now;
  if (nextStatus === "failed") updates.failedReason = "ACK_ERROR";

  await recipientsCol().updateOne({ _id: recipient._id }, { $set: updates });
  await statusEventsCol().insertOne({
    recipientId: recipient._id,
    whatsappMessageId: waId,
    status: nextStatus,
    ack,
    at: now,
    createdAt: now,
    updatedAt: now,
  });
  const stats = await refreshCampaignStats(recipient.campaignId);
  void notifyCampaignApiEvent({
    campaignId: String(recipient.campaignId),
    recipientId: String(recipient._id),
    status: nextStatus,
    stats,
  });
}

export async function handleCampaignInboundMessage(msg) {
  if (msg.fromMe) return;
  const from = msg.from || "";
  const digits = from.replace("@c.us", "").replace(/\D/g, "");
  let mobile = digits;
  if (digits.length === 10) mobile = `91${digits}`;
  else if (digits.length === 12 && digits.startsWith("91")) mobile = digits;

  const body = msg.body || "";
  const waId = msg.id?._serialized;
  let fromName = "";
  try {
    const c = await msg.getContact();
    fromName = c?.pushname || c?.name || "";
  } catch {
    /* ignore */
  }

  const recentRecipient = await recipientsCol()
    .find({ mobile })
    .sort({ updatedAt: -1 })
    .limit(1)
    .next();

  const now = new Date();
  await incomingCol().insertOne({
    whatsappMessageId: waId,
    fromMobile: mobile,
    fromName,
    body,
    messageType: msg.type || "chat",
    campaignId: recentRecipient?.campaignId || null,
    recipientId: recentRecipient?._id || null,
    readInApp: false,
    receivedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  if (recentRecipient?._id) {
    await recipientsCol().updateOne(
      { _id: recentRecipient._id },
      {
        $set: {
          replied: true,
          latestReply: body.slice(0, 2000),
          replyAt: now,
        },
      }
    );
    const stats = await refreshCampaignStats(recentRecipient.campaignId);
    void notifyCampaignApiEvent({
      campaignId: String(recentRecipient.campaignId),
      recipientId: String(recentRecipient._id),
      status: "replied",
      stats,
    });
  }
}

export function getCampaignBridgeStatus() {
  return {
    mode: "erp",
    whatsappReady: isWhatsAppReady,
    linkedPhone: getWhatsAppLinkedPhone(),
  };
}
