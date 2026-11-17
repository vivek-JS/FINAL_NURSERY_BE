import mongoose from "mongoose";
import Order from "../models/order.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import { NEED_SOW_ORDER_STATUSES } from "../constants/sowingGapOrderStatuses.js";
import { orderAlreadyCovered, orderPlantTotal } from "./orderSowCover.plan.js";

const ACTIVE_ORDER_STATUSES = NEED_SOW_ORDER_STATUSES;

const asOid = (id) => {
  try {
    return new mongoose.Types.ObjectId(id);
  } catch {
    return null;
  }
};

export async function leftoverUncoveredIds({ plantId, subtypeId, plantIds } = {}) {
  const q = {
    sowingCompleted: true,
    sowingIncomplete: true,
    uncoveredOrderIds: { $exists: true, $ne: [] },
  };
  if (plantId) q.plantId = plantId;
  else if (plantIds?.length) q.plantId = { $in: plantIds };
  if (subtypeId) q.subtypeId = subtypeId;
  const rows = await SowingRequest.find(q).select("uncoveredOrderIds").lean();
  return [
    ...new Set(
      rows.flatMap((r) => (r.uncoveredOrderIds || []).map((id) => String(id)))
    ),
  ];
}

/**
 * Incomplete leftovers are keyed by the order flag (and request uncovered ids).
 * Booking slot is not the gate — a partial can sit on a different day than the drawer.
 */
export function leftoverLiveOrderFilter(filter = {}, requestIds = []) {
  const ids = (requestIds || []).map(asOid).filter(Boolean);
  const or = [{ leftoverFromIncomplete: true }];
  if (ids.length) or.push({ _id: { $in: ids } });

  const q = {
    sowingDone: { $ne: true },
    orderStatus: { $in: ACTIVE_ORDER_STATUSES },
    dealerOrder: { $ne: true },
    $or: or,
  };
  if (filter.plantId) q.plantName = filter.plantId;
  else if (filter.plantIds?.length) q.plantName = { $in: filter.plantIds };
  if (filter.subtypeId) q.plantSubtype = filter.subtypeId;
  return q;
}

function plantsStillOpen(order) {
  return Math.max(0, orderPlantTotal(order) - orderAlreadyCovered(order));
}

/**
 * Flagged leftovers for every subtype. Only ACCEPTED — completed and dispatched stay out.
 */
export function incompleteLeftoverFilter(filter = {}) {
  const q = {
    leftoverFromIncomplete: true,
    sowingDone: { $ne: true },
    orderStatus: { $in: ACTIVE_ORDER_STATUSES },
  };
  if (filter.plantId) q.plantName = filter.plantId;
  else if (filter.plantIds?.length) q.plantName = { $in: filter.plantIds };
  if (filter.subtypeId) q.plantSubtype = filter.subtypeId;
  return q;
}

export async function incompleteLeftoverOrders(filter = {}) {
  const rows = await Order.find(incompleteLeftoverFilter(filter))
    .select(
      "_id bookingSlot plantName plantSubtype numberOfPlants additionalPlants sowingCoverSources sowingPartialCover leftoverFromIncomplete orderStatus"
    )
    .lean();
  return rows.filter((order) => plantsStillOpen(order) > 0);
}

/** Slot rows, plus incomplete leftovers even when their booking slot is outside slotIds. */
export function orderWiseIncludeClause(slotIdList = [], leftoverOrders = [], activeStatuses = null) {
  const leftoverIds = (leftoverOrders || []).map((o) => o?._id).filter(Boolean);
  const slotClause = { bookingSlot: { $in: slotIdList } };
  if (activeStatuses?.length) slotClause.orderStatus = { $in: activeStatuses };
  if (slotIdList.length && leftoverIds.length) {
    return { $or: [slotClause, { _id: { $in: leftoverIds } }] };
  }
  if (slotIdList.length) return slotClause;
  if (leftoverIds.length) return { _id: { $in: leftoverIds } };
  return null;
}

export async function leftoverLiveOrders(filter = {}) {
  const ids = await leftoverUncoveredIds(filter);
  return Order.find(leftoverLiveOrderFilter(filter, ids))
    .select(
      "_id bookingSlot plantName plantSubtype numberOfPlants additionalPlants leftoverFromIncomplete"
    )
    .lean();
}

export async function leftoverBookingSlotIdSet(filter = {}) {
  const orders = await leftoverLiveOrders(filter);
  return new Set(
    orders.map((o) => String(o.bookingSlot || "")).filter((id) => id && id !== "undefined")
  );
}

export async function leftoverOrderIdSet(filter = {}) {
  const orders = await leftoverLiveOrders(filter);
  return new Set(orders.map((o) => String(o._id)));
}
