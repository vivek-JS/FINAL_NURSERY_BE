import catchAsync from "../utility/catchAsync.js";
import WhatsAppBroadcast from "../models/whatsappBroadcast.model.js";
import Farmer from "../models/farmer.model.js";
import FarmerLead from "../models/farmerLead.model.js";
import generateResponse from "../utility/responseFormat.js";

function phone10FromContactPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** Match farmer/lead activity to this broadcast contact (avoid stale read from older sends). */
function pickActivityForContact(activities, broadcastName, contact, broadcastSentAt) {
  const sentAtMs = broadcastSentAt ? new Date(broadcastSentAt).getTime() : 0;
  const matches = (activities || []).filter((act) => {
    if (act.broadcastName !== broadcastName) return false;
    if (contact.localMessageId && act.localMessageId) {
      return act.localMessageId === contact.localMessageId;
    }
    if (contact.whatsappMessageId && act.whatsappMessageId) {
      return act.whatsappMessageId === contact.whatsappMessageId;
    }
    if (!sentAtMs) return true;
    const actMs = act.timestamp ? new Date(act.timestamp).getTime() : 0;
    return actMs >= sentAtMs - 60_000;
  });
  return matches.length ? matches[matches.length - 1] : null;
}

function resolveContactStatusFromEntity(entity, broadcastName, contact, broadcastSentAt) {
  const act = pickActivityForContact(
    entity?.whatsappAutomationActivities,
    broadcastName,
    contact,
    broadcastSentAt
  );
  if (!act?.status) return null;
  return {
    status: act.status,
    deliveredAt: act.deliveredAt || null,
    readAt: act.readAt || null,
  };
}

function countFromStatus(status) {
  const s = String(status || "pending").toLowerCase();
  if (s === "sent") return { sent: 1, delivered: 0, read: 0, failed: 0 };
  if (s === "delivered") return { sent: 0, delivered: 1, read: 0, failed: 0 };
  if (s === "read") return { sent: 0, delivered: 0, read: 1, failed: 0 };
  if (s === "failed") return { sent: 0, delivered: 0, read: 0, failed: 1 };
  return { sent: 0, delivered: 0, read: 0, failed: 0 };
}

async function resolveContactStatusRecord(contact, broadcast) {
  const stored = String(contact.status || "pending").toLowerCase();
  if (stored !== "pending") {
    return {
      status: contact.status,
      deliveredAt: contact.deliveredAt || null,
      readAt: contact.readAt || null,
    };
  }

  const phone10 = phone10FromContactPhone(contact.phone);
  if (!phone10) return null;

  const farmer = await Farmer.findOne({ mobileNumber: parseInt(phone10, 10) }).lean();
  const fromFarmer = resolveContactStatusFromEntity(farmer, broadcast.name, contact, broadcast.sentAt);
  if (fromFarmer) return fromFarmer;

  const lead = await FarmerLead.findOne({ mobileNumber: phone10 }).lean();
  return resolveContactStatusFromEntity(lead, broadcast.name, contact, broadcast.sentAt);
}

// List broadcasts with counts (basic pagination)
export const listBroadcasts = catchAsync(async (req, res) => {
  const page = parseInt(req.query.page || "1", 10);
  const limit = parseInt(req.query.limit || "20", 10);
  const skip = (page - 1) * limit;

  const total = await WhatsAppBroadcast.countDocuments();
  const broadcasts = await WhatsAppBroadcast.find({})
    .sort({ sentAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  // Count by broadcast contact status (updated by webhook); fallback to Farmer/Lead activities for legacy
  const results = [];
  for (const b of broadcasts) {
    let sent = 0, delivered = 0, read = 0, failed = 0, replied = 0;
    for (const c of (b.contacts || [])) {
      if (c.replyText) replied++;
      const stored = String(c.status || "pending").toLowerCase();
      if (stored !== "pending") {
        const bucket = countFromStatus(stored);
        sent += bucket.sent;
        delivered += bucket.delivered;
        read += bucket.read;
        failed += bucket.failed;
        continue;
      }
      const statusRecord = await resolveContactStatusRecord(c, b);
      const bucket = countFromStatus(statusRecord?.status || "pending");
      sent += bucket.sent;
      delivered += bucket.delivered;
      read += bucket.read;
      failed += bucket.failed;
    }
    results.push({
      ...b,
      counts: { sent, delivered, read, failed, replied, totalRecipients: (b.contacts || []).length }
    });
  }

  return res.status(200).json(generateResponse("Success", "Broadcasts fetched", { total, page, limit, broadcasts: results }, undefined));
});

// Get broadcast detail (contacts + resolved statuses)
export const getBroadcastById = catchAsync(async (req, res) => {
  const { id } = req.params;
  const b = await WhatsAppBroadcast.findById(id).lean();
  if (!b) return res.status(404).json(generateResponse("Error", "Broadcast not found", null, "not_found"));

  // Use broadcast contact status (webhook-updated); fallback to Farmer/Lead for legacy
  const contactsWithStatus = [];
  for (const c of (b.contacts || [])) {
    const statusRecord = await resolveContactStatusRecord(c, b);
    contactsWithStatus.push({
      ...c,
      statusRecord,
      replyText: c.replyText || null,
      repliedAt: c.repliedAt || null,
    });
  }

  // Compute counts from contact status
  let sent = 0, delivered = 0, read = 0, failed = 0, replied = 0;
  for (const c of contactsWithStatus) {
    const s = (c.statusRecord?.status || c.status || "pending").toLowerCase();
    if (s === "sent") sent++;
    else if (s === "delivered") delivered++;
    else if (s === "read") read++;
    else if (s === "failed") failed++;
    if (c.replyText) replied++;
  }

  return res.status(200).json(generateResponse("Success", "Broadcast detail", {
    ...b,
    contacts: contactsWithStatus,
    counts: { sent, delivered, read, failed, replied, totalRecipients: (b.contacts || []).length }
  }, undefined));
});

