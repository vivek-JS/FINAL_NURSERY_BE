import Order from "../../../models/order.model.js";
import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
} from "../../../utility/istOrderDateStats.js";
import { duePipelineMatch } from "../../../utility/adminMisDue.js";
import { emptyDeliveryDay, statusToDeliveryBucket } from "../../../utility/adminDailyMisMerge.js";

const REMAINING_STATUSES = [
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
];

async function sumFutureOrdersPlants(match) {
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

/** Orders with delivery after range end — open pipeline only. */
export async function aggregateFutureDeliveryRows(rangeEnd) {
  const backlogMatch = {
    ...orderStatusExcludeMatch(),
    ...duePipelineMatch(),
    deliveryDate: { $gt: rangeEnd, $ne: null },
  };

  const [totalRow, statusRows] = await Promise.all([
    sumFutureOrdersPlants(backlogMatch),
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
    const bucketKey = statusToDeliveryBucket(row._id);
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
    key: "future",
    label: "Future delivery (after range)",
    booking: { orders: 0, plants: 0 },
    delivery,
    uniqueOrders: 0,
    isSynthetic: true,
    isFuture: true,
  };
}

export function futureDeliveryMatch(rangeEnd) {
  return {
    ...orderStatusExcludeMatch(),
    ...duePipelineMatch(),
    deliveryDate: { $gt: rangeEnd, $ne: null },
  };
}
