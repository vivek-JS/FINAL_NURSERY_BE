import mongoose from "mongoose";
import Order from "../models/order.model.js";
import SowingRequest from "../models/sowingRequest.model.js";

const ACTIVE_ORDER_STATUSES = [
  "PENDING",
  "PROCESSING",
  "ACCEPTED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
];

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

export async function leftoverLiveOrders(filter = {}) {
  const ids = (await leftoverUncoveredIds(filter))
    .map(asOid)
    .filter(Boolean);
  if (!ids.length) return [];
  return Order.find({
    _id: { $in: ids },
    sowingDone: { $ne: true },
    orderStatus: { $in: ACTIVE_ORDER_STATUSES },
  })
    .select("_id bookingSlot plantName plantSubtype numberOfPlants additionalPlants")
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
