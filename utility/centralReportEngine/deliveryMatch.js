/**
 * Central delivery filters for Admin MIS / central reports.
 * Change exclusions here only — aggregations and order drawer import this module.
 */

import { ORDER_EXCLUDED_STATUSES } from "../istOrderDateStats.js";

/** Not counted in Delivery — use Out (Dispatched) or Done (Completed) columns instead. */
export const DELIVERY_TOTAL_EXCLUDED_STATUSES = ["DISPATCHED", "COMPLETED"];

/** Delivery date in IST range, excluding cancelled/rejected, dispatched, and completed. */
export function matchDeliveryDateInRange(rangeStart, rangeEnd) {
  return {
    deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null },
    orderStatus: {
      $nin: [...ORDER_EXCLUDED_STATUSES, ...DELIVERY_TOTAL_EXCLUDED_STATUSES],
    },
  };
}
