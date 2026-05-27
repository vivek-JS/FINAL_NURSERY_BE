import {
  getOrderTotalPlants,
  getDispatchedQty,
} from "../services/dealerCommission.service.js";

const EMPTY_STATS = {
  totalBookedPlants: 0,
  totalDispatchedPlants: 0,
  remainingToDispatch: 0,
};

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
 * Aggregate booked / dispatched / remaining-to-dispatch per slot from orders.
 * @param {Array} orders - lean Order docs with bookingSlot, plants, dispatch fields
 * @returns {Map<string, { totalBookedPlants, totalDispatchedPlants, remainingToDispatch }>}
 */
export function computeSlotDispatchStatsFromOrders(orders) {
  const stats = { ...EMPTY_STATS };

  for (const order of orders || []) {
    const booked = getOrderTotalPlants(order);
    const dispatched = getDispatchedQty(order);
    const remaining =
      order.remainingPlants != null
        ? Math.max(0, Number(order.remainingPlants) || 0)
        : Math.max(0, booked - dispatched);

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
