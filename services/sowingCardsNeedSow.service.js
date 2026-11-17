import mongoose from "mongoose";
import Order from "../models/order.model.js";
import { NEED_SOW_ORDER_STATUSES } from "../constants/sowingGapOrderStatuses.js";
import { sowingStillShortExpr } from "./orderSowCover.plan.js";

/** Plants still uncovered. Covers from different requests add; the same request counts once. */
export function stillNeedsSowMatch() {
  return { $expr: sowingStillShortExpr() };
}

/**
 * Farmer orders that still need seed:
 * sowing not done, or partly covered with plants remaining.
 * Ignores the slot's stored totalBookedPlants counter.
 */
export function needSowOrderFilter(plantIds, statuses = NEED_SOW_ORDER_STATUSES) {
  return {
    plantName: { $in: plantIds },
    orderStatus: { $in: statuses },
    dealerOrder: { $ne: true },
    productMappingId: null,
    bookingSlot: { $exists: true, $ne: null },
    $and: [
      stillNeedsSowMatch(),
      {
        $or: [
          { quotaSource: { $exists: false } },
          { quotaSource: null },
          { quotaSource: { $ne: "dealer" } },
        ],
      },
    ],
  };
}

export async function bookingSlotIdsStillNeedingSow(plantIds, statuses) {
  if (!plantIds?.length) return [];
  const ids = await Order.distinct(
    "bookingSlot",
    needSowOrderFilter(plantIds, statuses)
  );
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    const key = id == null ? "" : String(id);
    if (!key || seen.has(key) || !mongoose.Types.ObjectId.isValid(key)) continue;
    seen.add(key);
    out.push(new mongoose.Types.ObjectId(key));
  }
  return out;
}

/**
 * Plants still to request on a sowing card.
 * This is the unsown order remainder only. Slot primarySowed and excess stock are not cover.
 */
export function gapFromUnsownOrders(orderRemainder) {
  return Math.max(0, Math.floor(Number(orderRemainder) || 0));
}

/** Instant sale: plants are handed over now, so this order does not need a sowing. */
export function isInstantHandOrder(order) {
  if (order?.instantDispatch === true) return true;
  const type = String(order?.orderType || "").trim().toLowerCase();
  if (type === "instant order" || type === "instant") return true;
  return (Array.isArray(order?.statusChanges) ? order.statusChanges : []).some((row) =>
    /instant order/i.test(String(row?.reason || ""))
  );
}

/**
 * Drop instant handovers and splits taken off an order that is already sown.
 * Those plants are given from the existing sow. They must not show as need-sow.
 */
export async function dropOrdersGivenWithoutSowing(OrderModel, orders) {
  const list = Array.isArray(orders) ? orders : [];
  const parentIds = [
    ...new Set(
      list
        .filter(
          (order) =>
            order?.isSplit &&
            order?.parentOrderId &&
            mongoose.Types.ObjectId.isValid(String(order.parentOrderId))
        )
        .map((order) => String(order.parentOrderId))
    ),
  ].map((id) => new mongoose.Types.ObjectId(id));
  let sownParents = new Set();
  if (parentIds.length && OrderModel?.find) {
    const parents = await OrderModel.find({ _id: { $in: parentIds }, sowingDone: true })
      .select("_id")
      .lean();
    sownParents = new Set(parents.map((parent) => String(parent._id)));
  }
  return list.filter((order) => {
    if (isInstantHandOrder(order)) return false;
    if (order?.isSplit && sownParents.has(String(order.parentOrderId || ""))) return false;
    return true;
  });
}
