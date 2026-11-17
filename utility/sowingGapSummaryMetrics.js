import mongoose from "mongoose";
import {
  groupOrdersByDeliverySlot,
  getNativeDeliveryCohortOrders,
  computeSlotDispatchStatsFromOrders,
} from "./slotDispatchStats.js";
import { applySowingAllowedSlotMetrics } from "./pastDueSlotMetrics.js";
import { capacityBoardIncludeBatch } from "./capacityBoardExcess.js";

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

const idStr = (value) => (value?._id != null ? String(value._id) : value == null ? "" : String(value));

const orderPlants = (order) =>
  Math.max(0, Math.floor(Number(order?.numberOfPlants) || 0) + Math.floor(Number(order?.additionalPlants) || 0));

/**
 * Delivery-window orders marked sown, but the sowing sits on another slot.
 * Those plants must not be painted as ready on this date.
 */
export function plantsSowedOnOtherSlot(orders, slot) {
  const slotId = idStr(slot?.slotId || slot?._id);
  const local = new Set();
  for (const batch of slot?.sowingBatches || []) {
    for (const id of batch?.linkedOrderIds || []) {
      const key = idStr(id);
      if (key) local.add(key);
    }
  }
  let elsewhere = 0;
  for (const order of orders || []) {
    if (!order?.sowingDone) continue;
    const qty = orderPlants(order);
    if (qty < 1) continue;
    const sources = Array.isArray(order.sowingCoverSources) ? order.sowingCoverSources : [];
    let named = 0;
    let onThis = 0;
    for (const src of sources) {
      const plants = Math.max(0, Math.floor(Number(src?.plants) || 0));
      const srcSlot = idStr(src?.slotId);
      if (!plants || !srcSlot) continue;
      named += plants;
      if (srcSlot === slotId) onThis += plants;
    }
    if (named > 0) {
      elsewhere += Math.max(0, qty - Math.min(qty, onThis));
      continue;
    }
    if (!local.has(idStr(order))) elsewhere += qty;
  }
  return elsewhere;
}

/** Same sowing gap / excess rules as GET slots (delivery window + sowingDone). */
export function computeSowingGapBoardMetricsForSubtype(
  slots,
  deliveryOrders,
  sowingBufferPct = 0,
  { todayYmd } = {}
) {
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
  const includeBatch = capacityBoardIncludeBatch({ todayYmd });

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
      availablePlants: 0,
      sowingBatches: slot.sowingBatches || [],
      primarySowed: Number(slot.primarySowed) || 0,
      ...stats,
    };
    applySowingAllowedSlotMetrics(enriched, sowingBufferPct, { includeBatch });

    const slotGap = Math.max(0, Number(stats.bookedUncoveredPlants) || 0);
    const primarySowed = Number(slot.primarySowed) || 0;
    const grossCover = Number(enriched.grossOrderCoveredPlants) || 0;
    const sowedElsewhere = plantsSowedOnOtherSlot(native, slot);
    // Excess = CMS percent off plants sowed, then minus the orders.
    const excessAvailableForBooking = Number(enriched.excessAvailableForBooking) || 0;

    metricsBySlotId.set(slotId, {
      sowedActualPlants: Number(enriched.sowedActualPlants) || 0,
      sowedExpectedMortality: Number(enriched.sowedExpectedMortality) || 0,
      totalBookedPlants: Number(stats.totalBookedPlants) || 0,
      bookedUncoveredPlants: slotGap,
      bookedCoveredPlants: Number(stats.bookedCoveredPlants) || 0,
      slotGap,
      excessAvailableForBooking,
      primarySowed,
      grossOrderCoveredPlants: grossCover,
      sowedElsewhere,
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
      "_id orderId orderStatus numberOfPlants additionalPlants sowingDone sowingCoverSources sowingPartialCover leftoverFromIncomplete deliveryDate quotaSource pastDueSlotRollover pastDueSlotRolloverAt plantName plantSubtype"
    )
    .lean();
}

/** Returns Map<slotId, metrics> aligned with slots page. */
export function applySowingGapBoardMetrics(allSlots, deliveryOrders, bufferByPlant = null, { todayYmd } = {}) {
  const bySubtype = groupFlatSlotsBySubtype(allSlots);
  const ordersByKey = new Map();
  for (const order of deliveryOrders || []) {
    const key = slotKey(order.plantName, order.plantSubtype);
    if (!ordersByKey.has(key)) ordersByKey.set(key, []);
    ordersByKey.get(key).push(order);
  }

  const allMetrics = new Map();
  for (const [key, slots] of bySubtype) {
    const plantId = String(slots[0]?.plantId || "");
    const sowingBufferPct = bufferByPlant?.get?.(plantId) || 0;
    const subtypeMetrics = computeSowingGapBoardMetricsForSubtype(
      slots,
      ordersByKey.get(key) || [],
      sowingBufferPct,
      { todayYmd }
    );
    for (const [slotId, metrics] of subtypeMetrics) {
      allMetrics.set(slotId, metrics);
    }
  }
  return allMetrics;
}
