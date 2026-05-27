import { getOrderTotalPlants } from "../services/dealerCommission.service.js";

const EMPTY_STATS = {
  totalBookedPlants: 0,
  totalDispatchedPlants: 0,
  remainingToDispatch: 0,
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
 * Aggregate booked / dispatched & completed / remaining per slot from orders.
 * Caller must exclude CANCELLED, REJECTED, and dealer-quota orders when loading orders.
 */
export function computeSlotDispatchStatsFromOrders(orders) {
  const stats = { ...EMPTY_STATS };

  for (const order of orders || []) {
    if (EXCLUDED_ORDER_STATUSES.has(order?.orderStatus)) {
      continue;
    }

    stats.totalBookedPlants += getOrderTotalPlants(order);
    stats.totalDispatchedPlants += getDispatchedAndCompletedQty(order);
    stats.remainingToDispatch += getRemainingToDispatchQty(order);
  }

  return stats;
}

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
    });
  }

  return statsBySlot;
}

export function getSlotDispatchStats(statsBySlot, slotId) {
  const key = slotId?.toString?.() ?? String(slotId);
  return statsBySlot.get(key) || { ...EMPTY_STATS };
}
