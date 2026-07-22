/**
 * Central delivery filters for Admin MIS / central reports.
 * Change exclusions here only — aggregations and order drawer import this module.
 */

import { ORDER_EXCLUDED_STATUSES } from "../istOrderDateStats.js";
import { orderStatusExcludeMatch } from "../istOrderDateStats.js";

/** Not counted in Delivery — use Out (Dispatched) or Done (Completed) columns instead. */
export const DELIVERY_TOTAL_EXCLUDED_STATUSES = ["DISPATCHED", "COMPLETED"];

const DELIVERY_OPEN_STATUS_FILTER = {
  $nin: [...ORDER_EXCLUDED_STATUSES, ...DELIVERY_TOTAL_EXCLUDED_STATUSES],
};

/** Inclusive IST delivery-date window (no status filter). */
export function deliveryDateInRangeOnly(rangeStart, rangeEnd) {
  return { deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null } };
}

/** Delivery date in IST range, excluding cancelled/rejected, dispatched, and completed. */
export function matchDeliveryDateInRange(rangeStart, rangeEnd) {
  return {
    ...deliveryDateInRangeOnly(rangeStart, rangeEnd),
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

/**
 * Orders with delivery in range AND a delivery change logged in range.
 * Prevents change-only matches from bypassing the delivery-date window.
 */
export function matchDeliveryChangesInRange(rangeStart, rangeEnd, extraMatch = {}) {
  return {
    ...extraMatch,
    ...deliveryDateInRangeOnly(rangeStart, rangeEnd),
    deliveryChanges: {
      $elemMatch: { createdAt: { $gte: rangeStart, $lte: rangeEnd } },
    },
  };
}

/** MIS / CEO drawer — delivery changed bucket. */
export function deliveryChangedMatch(rangeStart, rangeEnd) {
  return matchDeliveryChangesInRange(rangeStart, rangeEnd, orderStatusExcludeMatch());
}

/** MIS / CEO drawer — early delivery (cross-slot or change), delivery date in range. */
export function earlyDeliveryMatch(rangeStart, rangeEnd) {
  return {
    ...orderStatusExcludeMatch(),
    $or: [
      {
        dispatchedFromAnotherSlot: true,
        ...deliveryDateInRangeOnly(rangeStart, rangeEnd),
      },
      {
        ...deliveryDateInRangeOnly(rangeStart, rangeEnd),
        deliveryChanges: {
          $elemMatch: { createdAt: { $gte: rangeStart, $lte: rangeEnd } },
        },
      },
    ],
  };
}
