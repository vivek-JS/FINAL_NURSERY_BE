/**
 * ERP order WhatsApp outbound tracking — sent / delivered / read / farmer reply.
 */

import mongoose from "mongoose";
import OrderWhatsappOutbound from "../models/orderWhatsappOutbound.model.js";
import OrderWhatsappCampaign from "../models/orderWhatsappCampaign.model.js";

const STATUS_RANK = {
  pending: 0,
  failed: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

function isErpFarmReadyConfirmationStatusText(body) {
  const text = String(body?.text || body?.data?.text || "").trim();
  if (!text) return false;
  return text.includes("आपले शेत तयार असल्याची नोंद झाली");
}

/** ERP session auto-replies — not farm-ready template lifecycle. */
export function isErpSessionAutoReplyStatusText(body) {
  const text = String(body?.text || body?.data?.text || "").trim();
  if (!text) return false;
  if (isErpFarmReadyConfirmationStatusText(body)) return true;
  if (text.includes("आपली Delivery Date निश्चित झाली")) return true;
  if (text.includes("ERP मध्ये अपडेट झाले")) return true;
  return false;
}

/**
 * Only update farm-ready outbound log for template lifecycle — skip session text status
 * (WATI often sends delivered/read for ERP confirmation messages with type "text").
 */
export function shouldUpdateFarmReadyOutboundStatus(body, eventType) {
  const et = String(eventType || "").toLowerCase();
  if (et === "templatemessagesent_v2" || et === "templatemessagefailed") return true;
  if (
    ![
      "sentmessagedelivered",
      "sentmessagedelivered_v2",
      "sentmessageread",
      "sentmessageread_v2",
      "sentmessagereplied_v2",
    ].includes(et)
  ) {
    return false;
  }
  const msgType = String(body?.type || body?.data?.type || "").toLowerCase();
  if (msgType === "text" || msgType === "session") return false;
  if (body?.templateName || body?.templateId) return true;
  if (msgType === "template") return true;
  if (isErpSessionAutoReplyStatusText(body)) return false;
  return !msgType;
}

function normalizeMobile10(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length >= 10) return digits.slice(-10);
  return digits || null;
}

function pickLocalMessageId(result) {
  return (
    result?.data?.localMessageId ||
    result?.localMessageId ||
    result?.data?.receivers?.[0]?.localMessageId ||
    null
  );
}

function pickWatiWebhookId(result) {
  return (
    result?.data?.id ||
    result?.id ||
    result?.data?.receivers?.[0]?.id ||
    null
  );
}

function pickWhatsappMessageId(result) {
  return (
    result?.data?.whatsappMessageId ||
    result?.whatsappMessageId ||
    result?.data?.receivers?.[0]?.whatsappMessageId ||
    null
  );
}

/** ERP order # shown in log table (prefer numeric orderId over publicOrderCode). */
export function outboundDisplayOrderCode(orderOrOpts) {
  const orderId = orderOrOpts?.orderId;
  if (orderId != null && orderId !== "" && typeof orderId !== "object") {
    return String(orderId);
  }
  if (orderOrOpts?.publicOrderCode) {
    return String(orderOrOpts.publicOrderCode);
  }
  return null;
}

/**
 * @param {object} order — populated or lean order doc
 * @param {object} opts
 */
export async function createOutboundRecord(order, opts = {}) {
  if (!order?._id) return null;

  const farmer = order.farmer;
  const farmerName =
    typeof farmer === "object" && farmer?.name
      ? String(farmer.name)
      : typeof farmer === "string"
        ? farmer
        : null;
  const farmerMobile10 = normalizeMobile10(
    typeof farmer === "object" ? farmer?.mobileNumber : null
  );

  const now = new Date();
  const localMessageId = opts.localMessageId ? String(opts.localMessageId) : null;

  const doc = await OrderWhatsappOutbound.create({
    orderId: order._id,
    publicOrderCode:
      opts.displayOrderCode ||
      outboundDisplayOrderCode(order) ||
      order.publicOrderCode?.toString() ||
      null,
    farmerName,
    farmerMobile10,
    templateType: opts.templateType || "farm_ready",
    localMessageId,
    whatsappMessageId: opts.whatsappMessageId || null,
    watiWebhookId: opts.watiWebhookId ? String(opts.watiWebhookId) : null,
    status: localMessageId ? "sent" : "pending",
    sentAt: localMessageId ? now : null,
    sentBy: opts.sentBy || null,
    trigger: opts.trigger || null,
    batchId: opts.batchId || null,
    campaignName: opts.campaignName || null,
  });

  return doc;
}

/**
 * After WATI send — attach message id + mark sent.
 */
export async function markOutboundSentFromWatiResult(orderId, watiResult, opts = {}) {
  const localMessageId = pickLocalMessageId(watiResult);
  const whatsappMessageId = pickWhatsappMessageId(watiResult);
  const watiWebhookId = pickWatiWebhookId(watiResult);
  if (!localMessageId) {
    return createOutboundRecord(
      { _id: orderId, ...(opts.orderSnapshot || {}) },
      { ...opts, localMessageId: null, whatsappMessageId, watiWebhookId }
    );
  }

  const idOr = [{ localMessageId: String(localMessageId) }];
  if (watiWebhookId) idOr.push({ watiWebhookId: String(watiWebhookId) });

  const existing = await OrderWhatsappOutbound.findOne({ orderId, $or: idOr }).lean();

  if (existing) {
    await OrderWhatsappOutbound.updateOne(
      { _id: existing._id },
      {
        $set: {
          status: "sent",
          sentAt: existing.sentAt || new Date(),
          ...(whatsappMessageId && !existing.whatsappMessageId
            ? { whatsappMessageId: String(whatsappMessageId) }
            : {}),
          ...(watiWebhookId && !existing.watiWebhookId
            ? { watiWebhookId: String(watiWebhookId) }
            : {}),
          ...(opts.trigger ? { trigger: opts.trigger } : {}),
          ...(opts.sentBy ? { sentBy: opts.sentBy } : {}),
          ...(opts.batchId ? { batchId: opts.batchId } : {}),
          ...(opts.campaignName ? { campaignName: opts.campaignName } : {}),
          ...(opts.displayOrderCode ? { publicOrderCode: opts.displayOrderCode } : {}),
        },
      }
    );
    return existing;
  }

  return createOutboundRecord(
    {
      _id: orderId,
      orderId: opts.orderBusinessId,
      publicOrderCode: opts.displayOrderCode || opts.publicOrderCode,
      farmer: opts.farmer,
    },
    {
      templateType: opts.templateType || "farm_ready",
      localMessageId,
      whatsappMessageId,
      watiWebhookId,
      displayOrderCode: opts.displayOrderCode,
      trigger: opts.trigger,
      sentBy: opts.sentBy,
      batchId: opts.batchId,
      campaignName: opts.campaignName,
    }
  );
}

/**
 * @param {object} params
 * @param {string} [params.localMessageId]
 * @param {string} [params.whatsappMessageId]
 * @param {"sent"|"delivered"|"read"|"failed"} params.event
 */
export async function updateOutboundFromStatusWebhook({
  localMessageId,
  whatsappMessageId,
  watiWebhookId = null,
  event,
  timestamp = new Date(),
  failedCode = null,
  failedDetail = null,
}) {
  const query = { $or: [] };
  if (localMessageId) {
    query.$or.push({ localMessageId: String(localMessageId) });
    query.$or.push({ watiWebhookId: String(localMessageId) });
  }
  if (watiWebhookId) query.$or.push({ watiWebhookId: String(watiWebhookId) });
  if (whatsappMessageId) query.$or.push({ whatsappMessageId: String(whatsappMessageId) });
  if (localMessageId) query.$or.push({ whatsappMessageId: String(localMessageId) });
  if (!query.$or.length) return { matched: 0 };

  const doc = await OrderWhatsappOutbound.findOne(query).sort({ createdAt: -1 });
  if (!doc) return { matched: 0 };

  const nextStatus = event === "failed" ? "failed" : event;
  const currentRank = STATUS_RANK[doc.status] ?? 0;
  const nextRank = STATUS_RANK[nextStatus] ?? 0;

  const $set = {};
  if (nextStatus === "failed" || nextRank >= currentRank) {
    $set.status = nextStatus;
  }
  if (whatsappMessageId && !doc.whatsappMessageId) {
    $set.whatsappMessageId = String(whatsappMessageId);
  }
  if (watiWebhookId && !doc.watiWebhookId) {
    $set.watiWebhookId = String(watiWebhookId);
  }
  if (event === "sent" && !$set.sentAt && !doc.sentAt) $set.sentAt = timestamp;
  if (event === "delivered") $set.deliveredAt = timestamp;
  if (event === "read") $set.readAt = timestamp;
  if (event === "failed") {
    if (failedCode) $set.failedCode = String(failedCode);
    if (failedDetail) $set.failedDetail = String(failedDetail).slice(0, 500);
  }

  if (Object.keys($set).length === 0) return { matched: 1, updated: false };

  await OrderWhatsappOutbound.updateOne({ _id: doc._id }, { $set });
  return { matched: 1, updated: true, id: String(doc._id) };
}

/**
 * Record farmer button/text reply on latest open outbound for order.
 * @param {object} params
 * @param {boolean} [params.forceUpdate] — update latest row even if farmerReplyAt already set
 */
export async function recordFarmerReply({
  orderId,
  localMessageId,
  text,
  action,
  messageId,
  forceUpdate = false,
}) {
  if (!orderId) return null;

  let doc = null;
  if (localMessageId) {
    doc = await OrderWhatsappOutbound.findOne({
      orderId,
      localMessageId: String(localMessageId),
    });
  }
  if (!doc) {
    doc = await OrderWhatsappOutbound.findOne({
      orderId,
      templateType: "farm_ready",
      ...(forceUpdate ? {} : { farmerReplyAt: null }),
    }).sort({ createdAt: -1 });
  }

  if (!doc) return null;

  const now = new Date();
  const currentRank = STATUS_RANK[doc.status] ?? 0;
  const $set = {
    farmerReplyText: String(text ?? "").slice(0, 4000),
    farmerReplyAction: action || null,
    farmerReplyAt: now,
    farmerReplyMessageId: messageId || null,
  };
  if (currentRank < STATUS_RANK.delivered) {
    $set.status = "delivered";
    $set.deliveredAt = doc.deliveredAt || now;
  }
  if (currentRank < STATUS_RANK.read) {
    $set.status = "read";
    $set.readAt = now;
  }

  await OrderWhatsappOutbound.updateOne(
    { _id: doc._id },
    { $set }
  );

  return doc;
}

/**
 * After farmer completes दुसरी तारीख निवडा flow — store final slot + date on campaign log row.
 */
export async function recordFarmerRescheduleComplete(orderId, { slotLabel, deliveryLabel, messageId } = {}) {
  const slot = String(slotLabel ?? "").trim() || "—";
  const date = String(deliveryLabel ?? "").trim() || "—";
  return recordFarmerReply({
    orderId,
    text: `दुसरी तारीख निवडा → Slot: ${slot}, Date: ${date}`,
    action: "delivery_rescheduled",
    messageId: messageId || null,
    forceUpdate: true,
  });
}

/**
 * @param {object} params
 */
export async function listOutboundLogs({
  page = 1,
  limit = 50,
  orderId = null,
  status = null,
  batchId = null,
  templateType = "farm_ready",
} = {}) {
  const safePage = Math.max(1, parseInt(String(page), 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 50));
  const skip = (safePage - 1) * safeLimit;

  const filter = {};
  if (templateType) filter.templateType = templateType;
  if (status) filter.status = String(status).toLowerCase();
  if (batchId === "none") {
    filter.$or = [{ batchId: null }, { batchId: "" }];
  } else if (batchId) {
    filter.batchId = String(batchId);
  }
  if (orderId && mongoose.isValidObjectId(orderId)) {
    filter.orderId = new mongoose.Types.ObjectId(String(orderId));
  }

  const [rows, total] = await Promise.all([
    OrderWhatsappOutbound.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .populate("orderId", "orderId publicOrderCode orderStatus")
      .populate("sentBy", "name")
      .lean(),
    OrderWhatsappOutbound.countDocuments(filter),
  ]);

  return {
    data: rows,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.ceil(total / safeLimit) || 0,
    },
  };
}

export { pickLocalMessageId, normalizeMobile10 };

/** @param {string|null|undefined} raw @param {string} [fallback] */
export function normalizeCampaignName(raw, fallback = "Farm Ready Campaign") {
  const name = String(raw ?? "").trim();
  if (!name) return fallback;
  return name.slice(0, 120);
}

function emptyCampaignStats() {
  return {
    total: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0,
    replied: 0,
    pending: 0,
  };
}

function mapAggregateStats(row) {
  if (!row) return emptyCampaignStats();
  return {
    total: row.total || 0,
    sent: row.sent || 0,
    delivered: row.delivered || 0,
    read: row.read || 0,
    failed: row.failed || 0,
    replied: row.replied || 0,
    pending: row.pending || 0,
  };
}

async function aggregateOutboundStatsByBatch(batchIds) {
  if (!batchIds?.length) return {};
  const rows = await OrderWhatsappOutbound.aggregate([
    { $match: { batchId: { $in: batchIds.map(String) } } },
    {
      $group: {
        _id: "$batchId",
        total: { $sum: 1 },
        sent: {
          $sum: {
            $cond: [{ $in: ["$status", ["sent", "delivered", "read"]] }, 1, 0],
          },
        },
        delivered: {
          $sum: {
            $cond: [{ $in: ["$status", ["delivered", "read"]] }, 1, 0],
          },
        },
        read: {
          $sum: { $cond: [{ $eq: ["$status", "read"] }, 1, 0] },
        },
        failed: {
          $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
        },
        replied: {
          $sum: { $cond: [{ $ifNull: ["$farmerReplyAt", false] }, 1, 0] },
        },
        pending: {
          $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
        },
      },
    },
  ]);
  const out = {};
  for (const row of rows) {
    out[String(row._id)] = mapAggregateStats(row);
  }
  return out;
}

/**
 * @param {object} opts
 */
export async function createWhatsappCampaign({
  batchId,
  campaignName,
  templateType = "farm_ready",
  sentBy = null,
  plannedCount = 0,
}) {
  if (!batchId) return null;
  return OrderWhatsappCampaign.create({
    batchId: String(batchId),
    campaignName: normalizeCampaignName(campaignName),
    templateType,
    sentBy: sentBy || null,
    plannedCount: Math.max(0, Number(plannedCount) || 0),
  });
}

/**
 * Paginated campaigns with live aggregated delivery/read/reply stats.
 */
export async function listWhatsappCampaigns({
  page = 1,
  limit = 20,
  templateType = "farm_ready",
} = {}) {
  const safePage = Math.max(1, parseInt(String(page), 10) || 1);
  const safeLimit = Math.min(50, Math.max(1, parseInt(String(limit), 10) || 20));
  const skip = (safePage - 1) * safeLimit;

  const filter = {};
  if (templateType) filter.templateType = templateType;

  const [campaigns, total] = await Promise.all([
    OrderWhatsappCampaign.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .populate("sentBy", "name")
      .lean(),
    OrderWhatsappCampaign.countDocuments(filter),
  ]);

  const statsByBatch = await aggregateOutboundStatsByBatch(
    campaigns.map((c) => c.batchId).filter(Boolean)
  );

  return {
    data: campaigns.map((c) => ({
      ...c,
      stats: statsByBatch[String(c.batchId)] || emptyCampaignStats(),
    })),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.ceil(total / safeLimit) || 0,
    },
  };
}

/** Stats for outbound rows not linked to a named campaign batch. */
export async function getUncategorizedOutboundStats(templateType = "farm_ready") {
  const match = {
    $or: [{ batchId: null }, { batchId: "" }],
  };
  if (templateType) match.templateType = templateType;

  const [row] = await OrderWhatsappOutbound.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        sent: {
          $sum: {
            $cond: [{ $in: ["$status", ["sent", "delivered", "read"]] }, 1, 0],
          },
        },
        delivered: {
          $sum: {
            $cond: [{ $in: ["$status", ["delivered", "read"]] }, 1, 0],
          },
        },
        read: {
          $sum: { $cond: [{ $eq: ["$status", "read"] }, 1, 0] },
        },
        failed: {
          $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
        },
        replied: {
          $sum: { $cond: [{ $ifNull: ["$farmerReplyAt", false] }, 1, 0] },
        },
        pending: {
          $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
        },
      },
    },
  ]);

  return mapAggregateStats(row);
}
