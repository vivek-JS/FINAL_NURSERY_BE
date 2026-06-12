import { getOrderTotalPlants } from "../services/dealerCommission.service.js";
import { isPastDueRolledInOrder } from "./pastDueSlotMetrics.js";
import { isDeliveryDateInSlotWindow } from "./findDeliverySlot.js";

const EMPTY_STATS = {
  totalBookedPlants: 0,
  totalDispatchedPlants: 0,
  dispatchedRolledInPlants: 0,
  dispatchedCrossSlotInPlants: 0,
  dispatchedOtherPlants: 0,
  totalAllDispatchedPlants: 0,
  remainingToDispatch: 0,
  remainingRolledIn: 0,
  remainingNative: 0,
};

/** Dispatched & completed column — DISPATCHED + COMPLETED only (full order qty). */
const DISPATCHED_AND_COMPLETED_STATUSES = new Set(["DISPATCHED", "COMPLETED"]);

/** Remaining to dispatch — pre-dispatch queue only. */
const REMAINING_TO_DISPATCH_STATUSES = new Set([
  "ACCEPTED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
]);

const EXCLUDED_ORDER_STATUSES = new Set([
  "CANCELLED",
  "REJECTED",
  "TEMPORARY_CANCELLED",
]);

/**
 * Resolve bookingSlot reference to a slot id string.
 * Supports ObjectId and legacy { slotId } shape.
 */
export function resolveBookingSlotId(bookingSlot) {
  if (!bookingSlot) return null;
  if (typeof bookingSlot === "object" && bookingSlot.slotId != null) {
    return bookingSlot.slotId.toString();
  }
  return bookingSlot.toString?.() ?? String(bookingSlot);
}

/**
 * Plants counted as dispatched & completed (DISPATCHED or COMPLETED only).
 */
export function getDispatchedAndCompletedQty(order) {
  if (!DISPATCHED_AND_COMPLETED_STATUSES.has(order?.orderStatus)) {
    return 0;
  }
  return getOrderTotalPlants(order);
}

/**
 * Plants still to dispatch (ACCEPTED, FARM_READY, READY_FOR_DISPATCH only).
 * CANCELLED / REJECTED → 0. Other statuses (e.g. DISPATCH_PROCESS, PENDING) → 0.
 */
export function getRemainingToDispatchQty(order) {
  if (EXCLUDED_ORDER_STATUSES.has(order?.orderStatus)) {
    return 0;
  }
  if (!REMAINING_TO_DISPATCH_STATUSES.has(order?.orderStatus)) {
    return 0;
  }
  return getOrderTotalPlants(order);
}

/**
 * Booked plants: delivery-date cohort on a slot window, excluding past-due rolled-in.
 */
export function computeBookedPlantsFromOrders(orders) {
  let totalBookedPlants = 0;
  for (const order of orders || []) {
    if (!isSlotStatEligibleOrder(order)) continue;
    if (isPastDueRolledInOrder(order)) continue;
    totalBookedPlants += getOrderTotalPlants(order);
  }
  return totalBookedPlants;
}

/** Delivery-window cohort for slot cards — excludes past-due rolled-in. */
export function getNativeDeliveryCohortOrders(orders) {
  return (orders || []).filter(
    (o) => isSlotStatEligibleOrder(o) && !isPastDueRolledInOrder(o)
  );
}

/**
 * Slot card stats: booked + remaining + dispatched share the same native delivery cohort
 * when `pipelineOrders` / `bookedOrders` are passed from groupOrdersByDeliverySlot.
 * `orders` (bookingSlot list) is kept for slot.orders attachment only.
 */
export function computeSlotDispatchStatsFromOrders(
  orders,
  { bookedOrders, pipelineOrders } = {}
) {
  const stats = { ...EMPTY_STATS };
  const pipeList =
    pipelineOrders !== undefined
      ? pipelineOrders
      : getNativeDeliveryCohortOrders(orders);

  for (const order of pipeList) {
    if (EXCLUDED_ORDER_STATUSES.has(order?.orderStatus)) {
      continue;
    }

    stats.totalDispatchedPlants += getDispatchedAndCompletedQty(order);
    const remaining = getRemainingToDispatchQty(order);
    stats.remainingToDispatch += remaining;
    stats.remainingNative += remaining;
  }

  stats.totalBookedPlants = computeBookedPlantsFromOrders(
    bookedOrders !== undefined ? bookedOrders : pipeList
  );

  return stats;
}

/** Rolled-in pre-dispatch queue (booking or delivery cohort) — for past-due breakdown only. */
export function addRolledRemainingToStats(stats, orders) {
  for (const order of orders || []) {
    if (!isPastDueRolledInOrder(order)) continue;
    if (EXCLUDED_ORDER_STATUSES.has(order?.orderStatus)) continue;
    stats.remainingRolledIn += getRemainingToDispatchQty(order);
  }
  return stats;
}

/** Rolled-in dispatched plants in delivery cohort (excluded from native dispatched). */
export function addRolledDispatchedToStats(stats, orders) {
  for (const order of orders || []) {
    if (!isPastDueRolledInOrder(order)) continue;
    if (EXCLUDED_ORDER_STATUSES.has(order?.orderStatus)) continue;
    stats.dispatchedRolledInPlants += getDispatchedAndCompletedQty(order);
  }
  return stats;
}

/**
 * Cross-slot early-in dispatched on bookingSlot (excludes past-due rollover).
 * Orders whose delivery already sits in the native cohort are counted only in totalDispatchedPlants.
 */
export function sumDispatchedCrossSlotOntoSlot(crossSlotOrders, slotIdSet, slotList = []) {
  const bySlot = new Map();
  const slotById = new Map();
  for (const slot of slotList || []) {
    const id = slot._id?.toString?.() ?? String(slot._id);
    slotById.set(id, slot);
  }

  for (const order of crossSlotOrders || []) {
    if (isPastDueRolledInOrder(order)) continue;
    const qty = getDispatchedAndCompletedQty(order);
    if (!qty) continue;
    const bookingId =
      order.bookingSlot?.toString?.() ?? String(order.bookingSlot || "");
    if (!bookingId || !slotIdSet.has(bookingId)) continue;

    const slot = slotById.get(bookingId);
    if (
      slot &&
      order.deliveryDate &&
      isDeliveryDateInSlotWindow(order.deliveryDate, slot)
    ) {
      continue;
    }

    bySlot.set(bookingId, (bySlot.get(bookingId) || 0) + qty);
  }
  return bySlot;
}

export function finalizeDispatchedBifurcation(stats, dispatchedCrossSlotIn = 0) {
  const native = Number(stats.totalDispatchedPlants) || 0;
  const rolled = Number(stats.dispatchedRolledInPlants) || 0;
  const cross = Number(dispatchedCrossSlotIn) || 0;
  stats.dispatchedCrossSlotInPlants = cross;
  stats.dispatchedOtherPlants = rolled + cross;
  stats.totalAllDispatchedPlants = native + rolled + cross;
  return stats;
}

const NON_DEALER_QUOTA_MATCH = {
  $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }],
};

/** Reusable filter for slot booked / dispatch stats (non-dealer farmer orders). */
export function isSlotStatEligibleOrder(order) {
  if (!order || EXCLUDED_ORDER_STATUSES.has(order.orderStatus)) return false;
  if (order.quotaSource === "dealer") return false;
  return true;
}

/**
 * Assign orders to slots by deliveryDate within each slot window (not bookingSlot).
 */
export function groupOrdersByDeliverySlot(orders, slots) {
  const slotList = (slots || []).filter((s) => s?.startDay && s?.endDay);
  const map = new Map();
  for (const slot of slotList) {
    const id = slot._id?.toString?.() ?? String(slot._id);
    map.set(id, []);
  }

  for (const order of orders || []) {
    if (!isSlotStatEligibleOrder(order) || !order.deliveryDate) continue;
    for (const slot of slotList) {
      if (isDeliveryDateInSlotWindow(order.deliveryDate, slot)) {
        const id = slot._id?.toString?.() ?? String(slot._id);
        if (map.has(id)) map.get(id).push(order);
        break;
      }
    }
  }
  return map;
}

export { NON_DEALER_QUOTA_MATCH };

export function aggregateSlotDispatchStats(orders) {
  const statsBySlot = new Map();

  for (const order of orders || []) {
    const slotId = resolveBookingSlotId(order.bookingSlot);
    if (!slotId) continue;

    const orderStats = computeSlotDispatchStatsFromOrders([order]);
    const prev = statsBySlot.get(slotId) || { ...EMPTY_STATS };
    statsBySlot.set(slotId, {
      totalBookedPlants: prev.totalBookedPlants + orderStats.totalBookedPlants,
      totalDispatchedPlants:
        prev.totalDispatchedPlants + orderStats.totalDispatchedPlants,
      remainingToDispatch: prev.remainingToDispatch + orderStats.remainingToDispatch,
      remainingRolledIn: prev.remainingRolledIn + orderStats.remainingRolledIn,
      remainingNative: prev.remainingNative + orderStats.remainingNative,
    });
  }

  return statsBySlot;
}

export function getSlotDispatchStats(statsBySlot, slotId) {
  const key = slotId?.toString?.() ?? String(slotId);
  return statsBySlot.get(key) || { ...EMPTY_STATS };
}
