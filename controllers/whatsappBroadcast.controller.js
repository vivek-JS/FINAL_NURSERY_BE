import catchAsync from "../utility/catchAsync.js";
import WhatsAppBroadcast from "../models/whatsappBroadcast.model.js";
import Farmer from "../models/farmer.model.js";
import FarmerLead from "../models/farmerLead.model.js";
import generateResponse from "../utility/responseFormat.js";

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
      const s = (c.status || "pending").toLowerCase();
      if (c.replyText) replied++;
      if (s === "sent") sent++;
      else if (s === "delivered") delivered++;
      else if (s === "read") read++;
      else if (s === "failed") failed++;
      else {
        // Fallback: Farmer/Lead activity for contacts not yet updated by webhook
        const phone = (c.phone || "").replace(/\D/g, "");
        const phone10 = phone.length >= 10 ? phone.slice(-10) : phone;
        const farmer = await Farmer.findOne({ mobileNumber: parseInt(phone10) }).lean();
        if (farmer) {
          const act = (farmer.whatsappAutomationActivities || []).filter(a => a.broadcastName === b.name).pop();
          if (act) {
            if (act.status === "sent") sent++;
            else if (act.status === "delivered") delivered++;
            else if (act.status === "read") read++;
            else if (act.status === "failed") failed++;
          }
        } else {
          const lead = await FarmerLead.findOne({ mobileNumber: phone10 }).lean();
          if (lead) {
            const act = (lead.whatsappAutomationActivities || []).filter(a => a.broadcastName === b.name).pop();
            if (act) {
              if (act.status === "sent") sent++;
              else if (act.status === "delivered") delivered++;
              else if (act.status === "read") read++;
              else if (act.status === "failed") failed++;
            }
          }
        }
      }
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
    let statusRecord = null;
    if (c.status && c.status !== "pending") {
      statusRecord = { status: c.status, deliveredAt: c.deliveredAt || null, readAt: c.readAt || null };
    } else {
      const phone = (c.phone || "").replace(/\D/g, "");
      const phone10 = phone.length >= 10 ? phone.slice(-10) : phone;
      const farmer = await Farmer.findOne({ mobileNumber: parseInt(phone10) }).lean();
      if (farmer) {
        const act = (farmer.whatsappAutomationActivities || []).filter(a => a.broadcastName === b.name).pop();
        if (act) statusRecord = { status: act.status, deliveredAt: act.deliveredAt || null, readAt: act.readAt || null };
      } else {
        const lead = await FarmerLead.findOne({ mobileNumber: phone10 }).lean();
        if (lead) {
          const act = (lead.whatsappAutomationActivities || []).filter(a => a.broadcastName === b.name).pop();
          if (act) statusRecord = { status: act.status, deliveredAt: act.deliveredAt || null, readAt: act.readAt || null };
        }
      }
    }
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
    counts: { sent, delivered, read, failed, totalRecipients: (b.contacts || []).length }
  }, undefined));
});

