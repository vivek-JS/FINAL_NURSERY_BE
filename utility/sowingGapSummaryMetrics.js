import mongoose from "mongoose";
import {
  groupOrdersByDeliverySlot,
  getNativeDeliveryCohortOrders,
  computeSlotDispatchStatsFromOrders,
} from "./slotDispatchStats.js";
import { applySowingAllowedSlotMetrics } from "./pastDueSlotMetrics.js";

function slotKey(plantId, subtypeId) {
  return `${plantId?.toString?.() ?? plantId}-${subtypeId?.toString?.() ?? subtypeId}`;
}

export function groupFlatSlotsBySubtype(allSlots) {
  const map = new Map();
  for (const slot of allSlots || []) {
    const key = slotKey(slot.plantId, slot.subtypeId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(slot);
  }
  return map;
}

/** Same sowing gap / excess rules as GET slots (delivery window + sowingDone). */
export function computeSowingGapBoardMetricsForSubtype(slots, deliveryOrders) {
  const slotRows = (slots || []).map((s) => ({
    _id: s.slotId,
    startDay: s.slotStartDay,
    endDay: s.slotEndDay,
    availablePlants: Number(s.availablePlants) || 0,
    sowingBatches: s.sowingBatches || [],
    primarySowed: Number(s.primarySowed) || 0,
  }));
  const byDelivery = groupOrdersByDeliverySlot(deliveryOrders, slotRows);
  const metricsBySlotId = new Map();

  for (const slot of slots || []) {
    const slotId = slot.slotId?.toString?.() ?? String(slot.slotId);
    const native = getNativeDeliveryCohortOrders(byDelivery.get(slotId) || []);
    const stats = computeSlotDispatchStatsFromOrders([], {
      pipelineOrders: native,
      bookedOrders: native,
    });
    const enriched = {
      _id: slot.slotId,
      startDay: slot.slotStartDay,
      endDay: slot.slotEndDay,
      availablePlants: Number(slot.availablePlants) || 0,
      sowingBatches: slot.sowingBatches || [],
      primarySowed: Number(slot.primarySowed) || 0,
      ...stats,
    };
    applySowingAllowedSlotMetrics(enriched);

    const slotGap = Math.max(0, Number(stats.bookedUncoveredPlants) || 0);
    const primarySowed = Number(slot.primarySowed) || 0;
    const grossCover = Number(enriched.grossOrderCoveredPlants) || 0;
    // Excess = sowed stock left after booking/order cover — never raw slot capacity.
    // Empty capacity slots (available=100k, primarySowed=0) must show excess 0.
    const excessAvailableForBooking =
      primarySowed > 0 ? Math.max(0, primarySowed - grossCover) : 0;

    metricsBySlotId.set(slotId, {
      totalBookedPlants: Number(stats.totalBookedPlants) || 0,
      bookedUncoveredPlants: slotGap,
      bookedCoveredPlants: Number(stats.bookedCoveredPlants) || 0,
      slotGap,
      excessAvailableForBooking,
      primarySowed,
      grossOrderCoveredPlants: grossCover,
    });
  }

  return metricsBySlotId;
}

export async function fetchDeliveryOrdersForPlants(plantIds, Order) {
  if (!plantIds?.length) return [];
  const ids = plantIds.map((id) =>
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id))
  );
  return Order.find({
    plantName: { $in: ids },
    deliveryDate: { $exists: true, $ne: null },
    orderStatus: { $nin: ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"] },
    $or: [
      { quotaSource: { $ne: "dealer" } },
      { quotaSource: { $exists: false } },
      { quotaSource: null },
    ],
  })
    .select(
      "_id orderId orderStatus numberOfPlants additionalPlants sowingDone deliveryDate quotaSource pastDueSlotRollover pastDueSlotRolloverAt plantName plantSubtype"
    )
    .lean();
}

/** Returns Map<slotId, metrics> aligned with slots page. */
export function applySowingGapBoardMetrics(allSlots, deliveryOrders) {
  const bySubtype = groupFlatSlotsBySubtype(allSlots);
  const ordersByKey = new Map();
  for (const order of deliveryOrders || []) {
    const key = slotKey(order.plantName, order.plantSubtype);
    if (!ordersByKey.has(key)) ordersByKey.set(key, []);
    ordersByKey.get(key).push(order);
  }

  const allMetrics = new Map();
  for (const [key, slots] of bySubtype) {
    const subtypeMetrics = computeSowingGapBoardMetricsForSubtype(
      slots,
      ordersByKey.get(key) || []
    );
    for (const [slotId, metrics] of subtypeMetrics) {
      allMetrics.set(slotId, metrics);
    }
  }
  return allMetrics;
}
