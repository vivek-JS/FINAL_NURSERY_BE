import { DUE_DELIVERY_STATUSES } from "./adminMisDue.js";
import {
  findCurrentSlotIdForGroup,
  isSlotExpiredByEndDay,
} from "../services/pastDueSlotRollover.service.js";

const DUE_PIPELINE_STATUS_SET = new Set(DUE_DELIVERY_STATUSES);

export function orderLinePlants(order) {
  return (Number(order.numberOfPlants) || 0) + (Number(order.additionalPlants) || 0);
}

export function isEligiblePastDueOrder(order) {
  if (order?.quotaSource === "dealer") return false;
  return DUE_PIPELINE_STATUS_SET.has(order?.orderStatus);
}

export function mapPastDueOrderRow(order) {
  return {
    _id: order._id?.toString?.() || String(order._id),
    orderId: order.orderId,
    orderStatus: order.orderStatus,
    plants: orderLinePlants(order),
    pastDueSlotRollover: isPastDueRolledInOrder(order),
  };
}

/** Past-due rollover line — strict so booked vs rolled-in never double-count. */
export function isPastDueRolledInOrder(order) {
  return (
    order?.pastDueSlotRollover === true || Boolean(order?.pastDueSlotRolloverAt)
  );
}

/** Sum plants on slot from early/cross-slot moves — excludes past-due rollover. */
export function sumEarlyDispatchOntoSlot(crossSlotOrders, slotIdSet) {
  const bySlot = new Map();
  for (const order of crossSlotOrders || []) {
    if (order.pastDueSlotRollover) continue;
    const qty = orderLinePlants(order);
    const bookingId = order.bookingSlot?.toString?.() ?? String(order.bookingSlot || "");
    if (bookingId && slotIdSet.has(bookingId)) {
      bySlot.set(bookingId, (bySlot.get(bookingId) || 0) + qty);
    }
  }
  return bySlot;
}

/** Past-due pills: one current slot per subtype — per-bucket order lists for UI. */
export function aggregatePastDueMetricsForSlotGroup(slots, ordersBySlot, asOfDate = new Date()) {
  let pastDueRolledInPlants = 0;
  let pastDuePendingOnSlot = 0;
  const currentSlotId = findCurrentSlotIdForGroup(slots, asOfDate);

  const rolledInOnCurrentSlot = [];
  const rolledInOnOtherSlots = [];
  const pendingBySlotMap = new Map();

  for (const slot of slots || []) {
    if (slot.status === false) continue;
    const slotId = slot._id?.toString?.() || String(slot._id);
    const orders = ordersBySlot.get(slotId) || [];
    const isCurrent = slotId === currentSlotId;

    for (const o of orders) {
      const qty = orderLinePlants(o);
      const row = mapPastDueOrderRow(o);

      if (isPastDueRolledInOrder(o)) {
        pastDueRolledInPlants += qty;
        if (isCurrent) rolledInOnCurrentSlot.push(row);
        else rolledInOnOtherSlots.push(row);
      }

      if (isSlotExpiredByEndDay(slot, asOfDate) && isEligiblePastDueOrder(o)) {
        pastDuePendingOnSlot += qty;
        if (!pendingBySlotMap.has(slotId)) {
          pendingBySlotMap.set(slotId, {
            slotId,
            startDay: slot.startDay,
            endDay: slot.endDay,
            label: `${slot.startDay}–${slot.endDay}`,
            orderCount: 0,
            plants: 0,
            orders: [],
          });
        }
        const bucket = pendingBySlotMap.get(slotId);
        bucket.orders.push(row);
        bucket.orderCount += 1;
        bucket.plants += qty;
      }
    }
  }

  const pendingBySlot = [...pendingBySlotMap.values()].sort(
    (a, b) => b.plants - a.plants || b.orderCount - a.orderCount
  );

  const pastDueRolledInOrders =
    rolledInOnCurrentSlot.length + rolledInOnOtherSlots.length;
  const pastDuePendingOrders = pendingBySlot.reduce((s, b) => s + b.orderCount, 0);

  return {
    currentSlotId,
    pastDueRolledInPlants,
    pastDuePendingOnSlot,
    pastDueRolledInOrders,
    pastDuePendingOrders,
    pastDueDetail: {
      rolledInOnCurrentSlot: {
        orderCount: rolledInOnCurrentSlot.length,
        plants: rolledInOnCurrentSlot.reduce((s, r) => s + r.plants, 0),
        orders: rolledInOnCurrentSlot,
      },
      rolledInOnOtherSlots: {
        orderCount: rolledInOnOtherSlots.length,
        plants: rolledInOnOtherSlots.reduce((s, r) => s + r.plants, 0),
        orders: rolledInOnOtherSlots,
      },
      pendingBySlot,
      pendingTotal: {
        orderCount: pendingBySlot.reduce((s, b) => s + b.orderCount, 0),
        plants: pastDuePendingOnSlot,
      },
    },
  };
}

/** Attach dispatch + past-due fields for one slot row (GET slots). */
export function buildSlotOrderMetrics({
  slot,
  slotId,
  orders,
  dispatchStats,
  pastDueGroup,
  dispatchedFromOtherBySlot,
  releasedForEarlyBySlot,
}) {
  const isCurrentSlot = slotId === pastDueGroup.currentSlotId;
  const rolledOnCurrent = pastDueGroup.pastDueDetail?.rolledInOnCurrentSlot || {};

  return {
    totalBookedPlants: dispatchStats.totalBookedPlants,
    totalDispatchedPlants: dispatchStats.totalDispatchedPlants,
    remainingToDispatch: dispatchStats.remainingToDispatch,
    remainingRolledIn: dispatchStats.remainingRolledIn,
    remainingNative: dispatchStats.remainingNative,
    dispatchedFromOtherSlots: dispatchedFromOtherBySlot.get(slotId) || 0,
    releasedForEarlyDispatch: releasedForEarlyBySlot.get(slotId) || 0,
    isCurrentDateSlot: isCurrentSlot,
    pastDueRolledInPlants: isCurrentSlot ? rolledOnCurrent.plants || 0 : 0,
    pastDueRolledInOrders: isCurrentSlot ? rolledOnCurrent.orderCount || 0 : 0,
    pastDuePendingOnSlot: isCurrentSlot ? pastDueGroup.pastDuePendingOnSlot : 0,
    pastDuePendingOrders: isCurrentSlot ? pastDueGroup.pastDuePendingOrders : 0,
    pastDueDetail: isCurrentSlot ? pastDueGroup.pastDueDetail : null,
    pastDueRolledInPlantsSubtype: isCurrentSlot ? pastDueGroup.pastDueRolledInPlants : 0,
    pastDuePendingOnSlotSubtype: isCurrentSlot ? pastDueGroup.pastDuePendingOnSlot : 0,
  };
}
