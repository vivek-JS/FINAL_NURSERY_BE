import { getOrderTotalPlants } from "../services/dealerCommission.service.js";

const EMPTY_STATS = {
  totalBookedPlants: 0,
  totalDispatchedPlants: 0,
  remainingToDispatch: 0,
};

/** Plants already sent — DISPATCHED / COMPLETED (full order) or partial from in-progress dispatch. */
const DISPATCHED_OR_COMPLETED_FULL = new Set(["DISPATCHED", "COMPLETED"]);
const DISPATCH_IN_PROGRESS = new Set(["DISPATCH_PROCESS", "PARTIALLY_COMPLETED"]);

/** Orders still in the booking pipeline — all booked plants count as remaining to dispatch. */
const PENDING_DISPATCH_STATUSES = new Set([
  "PENDING",
  "ACCEPTED",
  "ASSIGNED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
]);

const EXCLUDED_FROM_REMAINING = new Set([
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
 * Plants counted as dispatched & completed for slot stock UI.
 * - DISPATCHED / COMPLETED → full order quantity
 * - DISPATCH_PROCESS / PARTIALLY_COMPLETED → quantity already sent (history or total − remainingPlants)
 * - Other statuses → 0
 */
export function getDispatchedAndCompletedQty(order) {
  const total = getOrderTotalPlants(order);
  if (total <= 0) return 0;

  const status = order?.orderStatus;
  if (DISPATCHED_OR_COMPLETED_FULL.has(status)) {
    return total;
  }

  if (DISPATCH_IN_PROGRESS.has(status)) {
    const historyQty = (order.dispatchHistory || []).reduce(
      (sum, row) => sum + Number(row.quantity || 0),
      0
    );
    if (historyQty > 0) return Math.min(total, historyQty);

    const remaining = order.remainingPlants;
    if (remaining != null && Number.isFinite(Number(remaining))) {
      return Math.max(0, total - Math.max(0, Number(remaining)));
    }
    return 0;
  }

  return 0;
}

/**
 * Plants still to ship for this order. CANCELLED / REJECTED → 0 (caller should also filter these out).
 */
export function getRemainingToDispatchQty(order) {
  const status = order?.orderStatus;
  if (EXCLUDED_FROM_REMAINING.has(status)) {
    return 0;
  }

  const booked = getOrderTotalPlants(order);
  if (booked <= 0) return 0;

  if (PENDING_DISPATCH_STATUSES.has(status)) {
    return booked;
  }

  const sent = getDispatchedAndCompletedQty(order);

  if (order.remainingPlants != null && Number.isFinite(Number(order.remainingPlants))) {
    return Math.max(0, Number(order.remainingPlants));
  }

  return Math.max(0, booked - sent);
}

/**
 * Aggregate booked / dispatched & completed / remaining per slot from orders.
 * Caller must exclude CANCELLED, REJECTED, and dealer-quota orders when loading orders.
 */
export function computeSlotDispatchStatsFromOrders(orders) {
  const stats = { ...EMPTY_STATS };

  for (const order of orders || []) {
    if (EXCLUDED_FROM_REMAINING.has(order?.orderStatus)) {
      continue;
    }

    const booked = getOrderTotalPlants(order);
    const dispatched = getDispatchedAndCompletedQty(order);
    const remaining = getRemainingToDispatchQty(order);

    stats.totalBookedPlants += booked;
    stats.totalDispatchedPlants += dispatched;
    stats.remainingToDispatch += remaining;
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
