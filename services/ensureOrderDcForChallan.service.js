import Order from "../models/order.model.js";
import { ensureOfficialDcSetFields } from "./officialDeliveryChallan.service.js";
import { hasPendingLinkedAgriLoadForOrder } from "./linkedAgriLoadGuard.service.js";

function orderHasAnyDcNumber(orderDoc) {
  return Boolean(
    String(orderDoc?.officialDeliveryChallanNumber || "").trim() ||
      String(orderDoc?.officialNonBillableDeliveryChallanNumber || "").trim() ||
      String(orderDoc?.deliveryChallanInvoiceNumber || "").trim()
  );
}

/**
 * Allocate CMS delivery-challan sequence numbers when the order is eligible
 * but official DC fields are still empty (e.g. deferred by agri-load guard).
 */
export async function ensureOrderDcNumbersIfEligible(orderDoc, session = null) {
  if (!orderDoc?._id) {
    return { setFields: {}, primaryLabel: null, order: orderDoc };
  }

  if (orderHasAnyDcNumber(orderDoc)) {
    return { setFields: {}, primaryLabel: null, order: orderDoc };
  }

  const status = String(orderDoc.orderStatus || "").toUpperCase();
  if (status === "CANCELLED" || status === "REJECTED") {
    return { setFields: {}, primaryLabel: null, order: orderDoc };
  }

  const remaining =
    orderDoc.remainingPlants != null && Number.isFinite(Number(orderDoc.remainingPlants))
      ? Number(orderDoc.remainingPlants)
      : null;

  let eligible = status === "DISPATCHED";
  if (!eligible && remaining === 0) {
    eligible = !(await hasPendingLinkedAgriLoadForOrder(orderDoc._id, session));
  }

  if (!eligible) {
    return { setFields: {}, primaryLabel: null, order: orderDoc };
  }

  const ensured = await ensureOfficialDcSetFields(orderDoc, session);
  const setFields = ensured?.setFields || {};
  if (!Object.keys(setFields).length) {
    return { setFields: {}, primaryLabel: ensured?.primaryLabel || null, order: orderDoc };
  }

  return {
    ...ensured,
    setFields,
    order: { ...orderDoc, ...setFields },
  };
}

/** Ensure DC numbers for every order on a dispatch; returns count updated. */
export async function ensureDispatchOrdersDcNumbers(dispatchDoc, session = null) {
  const orders = Array.isArray(dispatchDoc?.orderIds) ? dispatchDoc.orderIds : [];
  let updated = 0;

  for (const order of orders) {
    const orderId = order?._id || order;
    if (!orderId) continue;

    const fullOrder =
      order && typeof order === "object" && (order.plantName || order.plantLineItems)
        ? order
        : await Order.findById(orderId).session(session || null).lean();
    if (!fullOrder) continue;

    const { setFields } = await ensureOrderDcNumbersIfEligible(fullOrder, session);
    if (!Object.keys(setFields).length) continue;

    await Order.findByIdAndUpdate(orderId, { $set: setFields }, { session: session || undefined });
    updated += 1;
  }

  return updated;
}
