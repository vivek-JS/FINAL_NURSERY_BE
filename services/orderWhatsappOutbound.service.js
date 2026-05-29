/**
 * ERP order WhatsApp outbound tracking — sent / delivered / read / farmer reply.
 */

import mongoose from "mongoose";
import OrderWhatsappOutbound from "../models/orderWhatsappOutbound.model.js";

const STATUS_RANK = {
  pending: 0,
  failed: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

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
    status: localMessageId ? "sent" : "pending",
    sentAt: localMessageId ? now : null,
    sentBy: opts.sentBy || null,
    trigger: opts.trigger || null,
    batchId: opts.batchId || null,
  });

  return doc;
}

/**
 * After WATI send — attach message id + mark sent.
 */
export async function markOutboundSentFromWatiResult(orderId, watiResult, opts = {}) {
  const localMessageId = pickLocalMessageId(watiResult);
  const whatsappMessageId = pickWhatsappMessageId(watiResult);
  if (!localMessageId) {
    return createOutboundRecord(
      { _id: orderId, ...(opts.orderSnapshot || {}) },
      { ...opts, localMessageId: null, whatsappMessageId }
    );
  }

  const existing = await OrderWhatsappOutbound.findOne({
    orderId,
    localMessageId: String(localMessageId),
  }).lean();

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
          ...(opts.trigger ? { trigger: opts.trigger } : {}),
          ...(opts.sentBy ? { sentBy: opts.sentBy } : {}),
          ...(opts.batchId ? { batchId: opts.batchId } : {}),
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
      displayOrderCode: opts.displayOrderCode,
      trigger: opts.trigger,
      sentBy: opts.sentBy,
      batchId: opts.batchId,
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
  event,
  timestamp = new Date(),
  failedCode = null,
  failedDetail = null,
}) {
  const query = { $or: [] };
  if (localMessageId) query.$or.push({ localMessageId: String(localMessageId) });
  if (whatsappMessageId) query.$or.push({ whatsappMessageId: String(whatsappMessageId) });
  // WATI status webhooks sometimes send `id` equal to our stored localMessageId
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
 */
export async function recordFarmerReply({
  orderId,
  localMessageId,
  text,
  action,
  messageId,
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
      farmerReplyAt: null,
    }).sort({ createdAt: -1 });
  }

  if (!doc) return null;

  await OrderWhatsappOutbound.updateOne(
    { _id: doc._id },
    {
      $set: {
        farmerReplyText: String(text ?? "").slice(0, 4000),
        farmerReplyAction: action || null,
        farmerReplyAt: new Date(),
        farmerReplyMessageId: messageId || null,
      },
    }
  );

  return doc;
}

/**
 * @param {object} params
 */
export async function listOutboundLogs({
  page = 1,
  limit = 50,
  orderId = null,
  status = null,
  templateType = "farm_ready",
} = {}) {
  const safePage = Math.max(1, parseInt(String(page), 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 50));
  const skip = (safePage - 1) * safeLimit;

  const filter = {};
  if (templateType) filter.templateType = templateType;
  if (status) filter.status = String(status).toLowerCase();
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
