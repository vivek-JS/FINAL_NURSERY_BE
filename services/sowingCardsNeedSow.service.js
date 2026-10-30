import mongoose from "mongoose";
import Order from "../models/order.model.js";
import { NEED_SOW_ORDER_STATUSES } from "../constants/sowingGapOrderStatuses.js";

/** Sowing not done, or marked done while a partial hold still leaves plants. */
export function stillNeedsSowMatch() {
  const plantSum = {
    $add: [
      { $ifNull: ["$numberOfPlants", 0] },
      { $ifNull: ["$additionalPlants", 0] },
    ],
  };
  const covered = {
    $cond: [
      { $gt: [{ $sum: "$sowingCoverSources.plants" }, 0] },
      { $sum: "$sowingCoverSources.plants" },
      { $sum: "$sowingPartialCover.plants" },
    ],
  };
  return {
    $or: [
      { sowingDone: { $ne: true } },
      {
        sowingDone: true,
        $expr: {
          $and: [{ $gt: [covered, 0] }, { $lt: [covered, plantSum] }],
        },
      },
    ],
  };
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
