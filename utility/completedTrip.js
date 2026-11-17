/** Order is closed. A vehicle whose orders are all in this set is a completed trip. */
export const COMPLETED_ORDER_STATUSES = ["COMPLETED", "PARTIALLY_COMPLETED"];

/**
 * Trip is finished: freight/order form marked it delivered, an invoice exists,
 * or every order on it is completed.
 */
export function isCompletedTrip({ invoiceUrl = "", orderStatuses = [], tripStatus = "" } = {}) {
  if (String(tripStatus || "").toLowerCase() === "delivered") return true;
  if (String(invoiceUrl || "").trim()) return true;
  const statuses = (orderStatuses || [])
    .map((s) => String(s || "").toUpperCase())
    .filter(Boolean);
  if (!statuses.length) return false;
  return statuses.every((s) => COMPLETED_ORDER_STATUSES.includes(s));
}

/** Drop completed dispatch ids without wiping an existing `_id` search constraint. */
export function excludeDispatchIds(filter, ids) {
  if (!ids?.length) return filter;
  const constraint = { $nin: ids };
  if (!filter._id) {
    filter._id = constraint;
    return filter;
  }
  filter.$and = [...(filter.$and || []), { _id: filter._id }, { _id: constraint }];
  delete filter._id;
  return filter;
}
