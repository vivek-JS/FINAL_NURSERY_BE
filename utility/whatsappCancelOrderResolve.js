/**
 * Resolve which cancelled order a WATI cancel-revive reply belongs to.
 */

import mongoose from "mongoose";
import Order from "../models/order.model.js";
import {
  extractReplyContextId,
  extractReplyContextText,
  extractOrderRefsFromText,
} from "./whatsappFarmReadyOrderResolve.js";

const REVIVABLE_STATUSES = ["CANCELLED", "TEMPORARY_CANCELLED"];

function orderPopulate() {
  return [
    { path: "farmer", select: "name mobileNumber village" },
    { path: "plantName", select: "name" },
    { path: "plantSubtype", select: "name" },
  ];
}

async function findRevivableOrder(query) {
  return Order.findOne({
    ...query,
    orderStatus: { $in: REVIVABLE_STATUSES },
  }).populate(orderPopulate());
}

async function findByReference(ref, farmerId) {
  if (ref.kind === "publicOrderCode" && /^\d{4}$/.test(ref.value)) {
    return findRevivableOrder({ farmer: farmerId, publicOrderCode: ref.value });
  }
  if (ref.kind === "orderId") {
    const num = Number(ref.value);
    if (Number.isFinite(num)) {
      const byNum = await findRevivableOrder({ farmer: farmerId, orderId: num });
      if (byNum) return byNum;
    }
    if (/^\d{4}$/.test(ref.value)) {
      return findRevivableOrder({ farmer: farmerId, publicOrderCode: ref.value });
    }
  }
  if (mongoose.isValidObjectId(ref.value)) {
    return findRevivableOrder({ farmer: farmerId, _id: ref.value });
  }
  return null;
}

/**
 * @param {object} params
 * @param {object} params.body - Raw WATI webhook body
 * @param {string} params.farmerId - Farmer ObjectId string
 * @param {string} [params.inboundText]
 */
export async function findOrderForCancelReviveReply({ body, farmerId, inboundText = "" }) {
  if (!farmerId) return null;

  const ctxId = extractReplyContextId(body);
  if (ctxId) {
    const byContext = await findRevivableOrder({
      farmer: farmerId,
      whatsappCancelMessageKey: ctxId,
    });
    if (byContext) return byContext;
  }

  const contextText = extractReplyContextText(body);
  const searchBlob = [contextText, inboundText].filter(Boolean).join("\n");
  const refs = extractOrderRefsFromText(searchBlob);
  for (const ref of refs) {
    const order = await findByReference(ref, farmerId);
    if (order) return order;
  }

  return Order.findOne({
    farmer: farmerId,
    orderStatus: { $in: REVIVABLE_STATUSES },
    whatsappCancelSentAt: { $ne: null },
  })
    .sort({ whatsappCancelSentAt: -1, updatedAt: -1 })
    .populate(orderPopulate());
}
