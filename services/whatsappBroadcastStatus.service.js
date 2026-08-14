import WhatsAppBroadcast from "../models/whatsappBroadcast.model.js";

const STATUS_RANK = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 99,
};

function shouldApplyStatus(currentStatus, nextStatus) {
  const current = STATUS_RANK[String(currentStatus || "pending").toLowerCase()] ?? 0;
  const next = STATUS_RANK[String(nextStatus || "").toLowerCase()];
  if (next == null) return false;
  if (current === STATUS_RANK.failed) return nextStatus === "failed";
  return next >= current;
}

export function phoneVariants(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return [];
  const phone10 = digits.length >= 10 ? digits.slice(-10) : digits;
  const fullPhone = phone10.length === 10 ? `91${phone10}` : digits;
  return [...new Set([fullPhone, phone10, phone, digits].filter(Boolean))];
}

function buildContactArrayFilter({ localMessageId, whatsappMessageId, phoneMatch }) {
  const or = [];
  if (localMessageId) or.push({ "c.localMessageId": localMessageId });
  if (whatsappMessageId) or.push({ "c.whatsappMessageId": whatsappMessageId });
  if (phoneMatch?.length) or.push({ "c.phone": { $in: phoneMatch } });
  if (!or.length) return null;
  return or.length === 1 ? or[0] : { $or: or };
}

async function findBroadcastForContact({ localMessageId, whatsappMessageId, phone }) {
  const phoneMatch = phoneVariants(phone);

  if (localMessageId) {
    const byLocal = await WhatsAppBroadcast.findOne({ "contacts.localMessageId": localMessageId })
      .sort({ sentAt: -1 })
      .select("_id name")
      .lean()
      .catch(() => null);
    if (byLocal) return byLocal;
  }

  if (whatsappMessageId) {
    const byWa = await WhatsAppBroadcast.findOne({ "contacts.whatsappMessageId": whatsappMessageId })
      .sort({ sentAt: -1 })
      .select("_id name")
      .lean()
      .catch(() => null);
    if (byWa) return byWa;
  }

  if (phoneMatch.length) {
    const byPhone = await WhatsAppBroadcast.findOne({ "contacts.phone": { $in: phoneMatch } })
      .sort({ sentAt: -1 })
      .select("_id name")
      .lean()
      .catch(() => null);
    if (byPhone) return byPhone;
  }

  return null;
}

/**
 * Update a campaign contact row (sent / delivered / read / failed).
 * Matches by localMessageId, whatsappMessageId, or phone on the most recent broadcast.
 */
export async function updateBroadcastContactStatus({
  localMessageId = null,
  whatsappMessageId = null,
  phone = null,
  status,
  deliveredAt = null,
  readAt = null,
  failedCode = null,
  failedDetail = null,
  broadcastName = null,
}) {
  if (!status) return { matched: false };

  const phoneMatch = phoneVariants(phone);
  let broadcast = null;

  if (broadcastName) {
    broadcast = await WhatsAppBroadcast.findOne({ name: broadcastName })
      .select("_id name")
      .lean()
      .catch(() => null);
  }
  if (!broadcast) {
    broadcast = await findBroadcastForContact({ localMessageId, whatsappMessageId, phone });
  }
  if (!broadcast) return { matched: false };

  const doc = await WhatsAppBroadcast.findById(broadcast._id).select("contacts").lean().catch(() => null);
  const currentContact = (doc?.contacts || []).find((c) => {
    if (localMessageId && c.localMessageId === localMessageId) return true;
    if (whatsappMessageId && c.whatsappMessageId === whatsappMessageId) return true;
    if (phoneMatch.length && phoneMatch.includes(c.phone)) return true;
    const c10 = String(c.phone || "").replace(/\D/g, "").slice(-10);
    return phoneMatch.some((p) => String(p).replace(/\D/g, "").slice(-10) === c10);
  });
  if (currentContact && !shouldApplyStatus(currentContact.status, status)) {
    return {
      matched: true,
      modified: false,
      skipped: true,
      broadcastId: broadcast._id,
      broadcastName: broadcast.name,
    };
  }

  const arrayFilter = buildContactArrayFilter({ localMessageId, whatsappMessageId, phoneMatch });
  if (!arrayFilter) return { matched: false, broadcastId: broadcast._id };

  const $set = { "contacts.$[c].status": status };
  if (localMessageId) $set["contacts.$[c].localMessageId"] = localMessageId;
  if (whatsappMessageId) $set["contacts.$[c].whatsappMessageId"] = whatsappMessageId;
  if (deliveredAt) $set["contacts.$[c].deliveredAt"] = deliveredAt;
  if (readAt) $set["contacts.$[c].readAt"] = readAt;
  if (failedCode != null) $set["contacts.$[c].failedCode"] = failedCode;
  if (failedDetail != null) $set["contacts.$[c].failedDetail"] = failedDetail;

  const result = await WhatsAppBroadcast.updateOne(
    { _id: broadcast._id },
    { $set },
    { arrayFilters: [arrayFilter] }
  ).catch((err) => {
    console.error("[broadcast status] update failed:", err?.message || err);
    return { matchedCount: 0, modifiedCount: 0 };
  });

  return {
    matched: (result.matchedCount || 0) > 0,
    modified: (result.modifiedCount || 0) > 0,
    broadcastId: broadcast._id,
    broadcastName: broadcast.name,
  };
}

/** Normalize WATI event names (case/format varies between WATI versions). */
export function classifyWatiStatusEvent(eventType, statusString) {
  const et = String(eventType || "").toLowerCase().replace(/[\s_-]/g, "");
  const ss = String(statusString || "").toLowerCase().trim();

  if (et.includes("templatemessagesent") || ss === "sent") return "sent";
  if (et.includes("sentmessagereplied") || ss === "replied") return "replied";
  if (et.includes("sentmessagedelivered") || ss === "delivered") return "delivered";
  if (et.includes("sentmessageread") || ss === "read") return "read";
  if (et.includes("templatemessagefailed") || ss === "failed") return "failed";
  return null;
}
