/**
 * Central delivery filters for Admin MIS / central reports.
 * Change exclusions here only — aggregations and order drawer import this module.
 */

import { ORDER_EXCLUDED_STATUSES } from "../istOrderDateStats.js";

/** Not counted in Delivery — use Out (Dispatched) or Done (Completed) columns instead. */
export const DELIVERY_TOTAL_EXCLUDED_STATUSES = ["DISPATCHED", "COMPLETED"];

const DELIVERY_OPEN_STATUS_FILTER = {
  $nin: [...ORDER_EXCLUDED_STATUSES, ...DELIVERY_TOTAL_EXCLUDED_STATUSES],
};

/** Delivery date in IST range, excluding cancelled/rejected, dispatched, and completed. */
export function matchDeliveryDateInRange(rangeStart, rangeEnd) {
  return {
    deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null },
    orderStatus: DELIVERY_OPEN_STATUS_FILTER,
  };
}

/** Backlog before range start (includeAllPastDue), same status rules as in-range delivery. */
export function matchDeliveryDateBeforeRange(rangeStart) {
  return {
    deliveryDate: { $lt: rangeStart, $ne: null },
    orderStatus: DELIVERY_OPEN_STATUS_FILTER,
  };
}
