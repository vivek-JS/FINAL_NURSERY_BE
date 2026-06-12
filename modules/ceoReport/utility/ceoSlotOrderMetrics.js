import mongoose from "mongoose";
import { DUE_DELIVERY_STATUSES } from "../../../utility/adminMisDue.js";
import { NON_DEALER_QUOTA_MATCH } from "../../../utility/slotDispatchStats.js";
import { isPastDueRolledInOrder } from "../../../utility/pastDueSlotMetrics.js";

function toOid(id) {
  if (!id) return null;
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return id;
  }
}

const EXCLUDED = new Set(["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"]);
const DISPATCHED = new Set(["DISPATCHED", "COMPLETED"]);
const DUE_SET = new Set(DUE_DELIVERY_STATUSES);

export function linePlants(o) {
  return Number(o.linePlantTotal ?? (Number(o.numberOfPlants || 0) + Number(o.additionalPlants || 0))) || 0;
}

export function pendingPlants(o) {
  if (!o || EXCLUDED.has(o.orderStatus) || DISPATCHED.has(o.orderStatus)) return 0;
  return DUE_SET.has(o.orderStatus) ? linePlants(o) : 0;
}

export function dispatchedPlants(o) {
  return DISPATCHED.has(o?.orderStatus) ? linePlants(o) : 0;
}

export function bookedPlants(o) {
  if (!o || EXCLUDED.has(o.orderStatus)) return 0;
  return linePlants(o);
}

/** Orders booked on slots in the filtered range (indexed on bookingSlot). */
export function slotIdsOrderMatch(slotIds, plantIds) {
  const ids = (slotIds || []).map(toOid).filter(Boolean);
  const match = {
    ...NON_DEALER_QUOTA_MATCH,
    orderStatus: { $nin: [...EXCLUDED] },
    dealerOrder: { $ne: true },
    bookingSlot: { $in: ids },
  };
  if (plantIds?.length === 1) match.plantName = toOid(plantIds[0]);
  else if (plantIds?.length > 1) match.plantName = { $in: plantIds.map(toOid) };
  return match;
}

/** Delivery-date cohort for daily charts (subset of slot-scoped orders). */
export function deliveryRangeMatch(plantIds, rangeStart, rangeEnd) {
  const match = {
    ...NON_DEALER_QUOTA_MATCH,
    orderStatus: { $nin: [...EXCLUDED] },
    dealerOrder: { $ne: true },
    deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null },
  };
  if (plantIds?.length === 1) match.plantName = toOid(plantIds[0]);
  else if (plantIds?.length > 1) match.plantName = { $in: plantIds.map(toOid) };
  return match;
}

export function pastDueMatch(plantIds, beforeDate) {
  const match = {
    ...NON_DEALER_QUOTA_MATCH,
    orderStatus: { $in: DUE_DELIVERY_STATUSES },
    dealerOrder: { $ne: true },
    deliveryDate: { $lt: beforeDate, $ne: null },
  };
  if (plantIds?.length === 1) match.plantName = toOid(plantIds[0]);
  else if (plantIds?.length > 1) match.plantName = { $in: plantIds.map(toOid) };
  return match;
}

export function rollupOrderMetrics(orders, rangeStart, rangeEnd, { bookedFromSlots } = {}) {
  let booked = bookedFromSlots ?? 0;
  let pending = 0;
  let dispatched = 0;
  let pastDueNative = 0;
  let pastDueRolled = 0;
  let changedOrders = 0;
  let changedPlants = 0;
  const byStatus = new Map();
  const rs = rangeStart?.getTime?.() ?? 0;
  const re = rangeEnd?.getTime?.() ?? Date.now();

  for (const o of orders) {
    const plants = linePlants(o);
    if (bookedFromSlots == null) booked += bookedPlants(o);
    pending += pendingPlants(o);
    dispatched += dispatchedPlants(o);

    const st = o.orderStatus || "OTHER";
    const bucket = byStatus.get(st) || { status: st, plants: 0, orders: 0 };
    bucket.plants += plants;
    bucket.orders += 1;
    byStatus.set(st, bucket);

    const hasChangeInRange = (o.deliveryChanges || []).some((c) => {
      const t = new Date(c.createdAt || c.updatedAt || 0).getTime();
      return t >= rs && t <= re;
    });
    if (hasChangeInRange) {
      changedOrders += 1;
      changedPlants += plants;
    }
    if (o._pastDue) {
      const p = pendingPlants(o);
      if (isPastDueRolledInOrder(o)) pastDueRolled += p;
      else pastDueNative += p;
    }
  }

  return {
    bookedPlants: booked,
    pendingDelivery: pending,
    dispatchedPlants: dispatched,
    pastDueNative,
    pastDueRolledIn: pastDueRolled,
    deliveryChangedOrders: changedOrders,
    deliveryChangedPlants: changedPlants,
    statusBreakdown: [...byStatus.values()].sort((a, b) => b.plants - a.plants),
  };
}
