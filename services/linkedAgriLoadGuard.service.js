import mongoose from "mongoose";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";

export const LINKED_AGRI_DC_BLOCK_MESSAGE =
  "Agri Input pending load — delivery challan is blocked until loaded";

/** Ram Agri row is cleared for nursery DC only when explicitly marked LOADED. */
export function isLinkedAgriLoadSatisfied(order) {
  const load = String(order?.agriLoadStatus || "").toUpperCase();
  return load === "LOADED";
}

export async function getPendingLinkedAgriLoads(orderIds = [], session = null) {
  const normalizedOrderIds = (Array.isArray(orderIds) ? orderIds : [])
    .filter((id) => mongoose.isValidObjectId(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!normalizedOrderIds.length) {
    return [];
  }

  let query = AgriSalesOrder.find({
    linkedNurseryOrderId: { $in: normalizedOrderIds },
    orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
  }).select(
    "orderNumber linkedNurseryOrderId linkedNurseryOrderCode customerName productName quantity lineItems agriLoadStatus dispatchStatus orderStatus"
  );

  if (session) {
    query = query.session(session);
  }

  const candidates = await query.lean();
  return candidates.filter((o) => !isLinkedAgriLoadSatisfied(o));
}

export async function hasPendingLinkedAgriLoadForOrder(orderId, session = null) {
  const pending = await getPendingLinkedAgriLoads([orderId], session);
  return pending.length > 0;
}

export async function assertLinkedAgriLoadForDc(orderId, session = null) {
  const pending = await getPendingLinkedAgriLoads([orderId], session);
  if (!pending.length) return;

  const refs = pending
    .map((o) => o.orderNumber || o.linkedNurseryOrderCode)
    .filter(Boolean)
    .join(", ");
  const err = new Error(
    refs ? `${LINKED_AGRI_DC_BLOCK_MESSAGE} (${refs})` : LINKED_AGRI_DC_BLOCK_MESSAGE
  );
  err.statusCode = 403;
  err.code = "LINKED_AGRI_LOAD_PENDING";
  throw err;
}
