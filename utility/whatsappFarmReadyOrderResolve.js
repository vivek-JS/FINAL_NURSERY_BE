/**
 * Resolve which order a farm-ready WATI reply belongs to.
 * Priority: replyContextId → order id in replied-to text → latest farm-ready WhatsApp order.
 */

import mongoose from "mongoose";
import Order from "../models/order.model.js";

const RESCHEDULABLE_STATUSES = ["FARM_READY", "ACCEPTED", "READY_FOR_DISPATCH"];

function pickString(...values) {
  for (const v of values) {
    if (v == null) continue;
    const s = typeof v === "string" ? v.trim() : String(v).trim();
    if (s) return s;
  }
  return "";
}

/** WATI `replyContextId` — parent template/session message id. */
export function extractReplyContextId(body) {
  const b = body || {};
  return pickString(
    b.replyContextId,
    b.replyContextID,
    b.data?.replyContextId,
    b.data?.replyContextID,
    b.context?.id,
    b.data?.context?.id,
    b.message?.context?.id,
    b.whatsappMessage?.context?.id
  );
}

/** Text of the message the farmer replied to (template body). */
export function extractReplyContextText(body) {
  const b = body || {};
  return pickString(
    b.replyContextMessage?.text,
    typeof b.replyContextMessage === "string" ? b.replyContextMessage : "",
    b.data?.replyContextMessage?.text,
    b.data?.replyContextMessage,
    b.quotedMessage?.text,
    b.parentMessage?.text,
    b.sourceMessage?.text,
    b.repliedMessage?.text,
    b.templateMessage?.text,
    b.data?.quotedMessage?.text
  );
}

/**
 * Extract order references from template / reply text.
 * @returns {Array<{ kind: "publicOrderCode"|"orderId", value: string }>}
 */
export function extractOrderRefsFromText(text) {
  if (!text) return [];
  const t = String(text);
  const refs = [];
  const seen = new Set();

  const push = (kind, value) => {
    const v = String(value || "").trim();
    if (!v || seen.has(`${kind}:${v}`)) return;
    seen.add(`${kind}:${v}`);
    refs.push({ kind, value: v });
  };

  for (const m of t.matchAll(
    /(?:order\s*(?:number|no|#|id)?|orderNumber|orderId|ऑर्डर\s*(?:आयडी|आय\.?\s*डी\.?|क्र\.?|नं\.?|#)?|#)\s*[:\-]?\s*(\d{4,5})/gi
  )) {
    const digits = m[1];
    if (digits.length === 4) push("publicOrderCode", digits);
    else push("orderId", digits);
  }

  for (const m of t.matchAll(/\b(\d{4})\b/g)) {
    push("publicOrderCode", m[1]);
  }

  for (const m of t.matchAll(/\b(\d{5})\b/g)) {
    push("orderId", m[1]);
  }

  return refs;
}

function orderPopulate() {
  return [
    { path: "farmer", select: "name mobileNumber village" },
    { path: "plantName", select: "name" },
    { path: "plantSubtype", select: "name" },
  ];
}

async function findReschedulableOrder(query) {
  return Order.findOne({
    ...query,
    orderStatus: { $in: RESCHEDULABLE_STATUSES },
  })
    .populate(orderPopulate());
}

async function findByReference(ref, farmerId) {
  if (ref.kind === "publicOrderCode" && /^\d{4}$/.test(ref.value)) {
    return findReschedulableOrder({ farmer: farmerId, publicOrderCode: ref.value });
  }
  if (ref.kind === "orderId") {
    const num = Number(ref.value);
    if (Number.isFinite(num)) {
      const byNum = await findReschedulableOrder({ farmer: farmerId, orderId: num });
      if (byNum) return byNum;
    }
    if (/^\d{4}$/.test(ref.value)) {
      return findReschedulableOrder({ farmer: farmerId, publicOrderCode: ref.value });
    }
  }
  if (mongoose.isValidObjectId(ref.value)) {
    return findReschedulableOrder({ farmer: farmerId, _id: ref.value });
  }
  return null;
}

/**
 * @param {object} params
 * @param {object} params.body - Raw WATI webhook body
 * @param {string} params.farmerId - Farmer ObjectId string
 * @param {string} [params.inboundText] - Farmer reply text / button label
 */
export async function findOrderForFarmReadyReply({ body, farmerId, inboundText = "" }) {
  if (!farmerId) return null;

  const ctxId = extractReplyContextId(body);
  if (ctxId) {
    const byContext = await findReschedulableOrder({
      farmer: farmerId,
      whatsappFarmReadyMessageKey: ctxId,
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
    orderStatus: { $in: RESCHEDULABLE_STATUSES },
  })
    .sort({ deliveryDate: 1, updatedAt: -1 })
    .populate(orderPopulate());
}

export { RESCHEDULABLE_STATUSES };
