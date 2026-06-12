import Order from "../models/order.model.js";
import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
} from "./istOrderDateStats.js";

import { emptyDeliveryDay, statusToDeliveryBucket } from "./adminDailyMisMerge.js";

/** Pre-completion pipeline — delivery still owed. */
export const DUE_DELIVERY_STATUSES = [
  "PENDING",
  "PROCESSING",
  "ACCEPTED",
  "ASSIGNED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
];

export function parseMisDueFlags(query = {}) {
  return {
    dueOnly: String(query.dueOnly ?? "") === "true",
    includeAllPastDue: String(query.includeAllPastDue ?? "") === "true",
  };
}

/** Status filter for MIS delivery aggregations. */
export function misDeliveryStatusMatch(dueOnly) {
  if (dueOnly) {
    return { orderStatus: { $in: DUE_DELIVERY_STATUSES } };
  }
  return orderStatusExcludeMatch();
}

/** Mongo match fragment: open due pipeline only. */
export function duePipelineMatch() {
  return { orderStatus: { $in: DUE_DELIVERY_STATUSES } };
}

async function sumDueOrdersPlants(match) {
  const rows = await Order.aggregate([
    { $match: match },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    {
      $group: {
        _id: null,
        orders: { $sum: 1 },
        plants: { $sum: "$linePlantTotal" },
      },
    },
  ]);
  return {
    orders: rows[0]?.orders ?? 0,
    plants: rows[0]?.plants ?? 0,
  };
}

/**
 * Due in selected delivery window vs backlog before range start.
 */
export async function aggregateDueSummary(rangeStart, rangeEnd, { dueOnly = false, extraMatch = {} } = {}) {
  const base = orderStatusExcludeMatch();
  const dueStatus = { orderStatus: { $in: DUE_DELIVERY_STATUSES } };

  const [inRange, pastDue] = await Promise.all([
    sumDueOrdersPlants({
      ...base,
      ...extraMatch,
      ...dueStatus,
      deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null },
    }),
    sumDueOrdersPlants({
      ...base,
      ...extraMatch,
      ...dueStatus,
      deliveryDate: { $lt: rangeStart, $ne: null },
    }),
  ]);

  const combined = {
    orders: inRange.orders + pastDue.orders,
    plants: inRange.plants + pastDue.plants,
  };

  return {
    inRange,
    pastDue,
    combined,
    dueOnly,
  };
}

const REMAINING_STATUSES = [
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
];

/** Delivery pipeline breakdown for orders due before range start (aligns with due summary). */
export async function aggregatePastDueDeliveryRows(rangeStart, extraMatch = {}) {
  const backlogMatch = {
    ...orderStatusExcludeMatch(),
    ...extraMatch,
    ...duePipelineMatch(),
    deliveryDate: { $lt: rangeStart, $ne: null },
  };

  const [totalRow, statusRows] = await Promise.all([
    sumDueOrdersPlants(backlogMatch),
    Order.aggregate([
      { $match: backlogMatch },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      {
        $group: {
          _id: "$orderStatus",
          orders: { $sum: 1 },
          plants: { $sum: "$linePlantTotal" },
          plantsRemaining: {
            $sum: {
              $cond: [
                { $in: ["$orderStatus", REMAINING_STATUSES] },
                { $ifNull: ["$remainingPlants", 0] },
                0,
              ],
            },
          },
        },
      },
    ]),
  ]);

  const delivery = emptyDeliveryDay();
  for (const row of statusRows) {
    const status = row._id;
    if (!status) continue;
    const bucketKey = statusToDeliveryBucket(status);
    const bucket = delivery[bucketKey];
    if (!bucket) continue;
    bucket.orders += row.orders || 0;
    bucket.plants += row.plants || 0;
    if (typeof bucket.plantsRemaining === "number") {
      bucket.plantsRemaining += row.plantsRemaining || 0;
    }
  }
  delivery.total = { ...totalRow };

  return {
    date: "past-due",
    label: "Past due (before range)",
    booking: { orders: 0, plants: 0 },
    delivery,
    uniqueOrders: 0,
    isPastDue: true,
  };
}
