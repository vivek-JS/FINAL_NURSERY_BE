import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import { getSlotTrailActivityName } from "../constants/slotTrailActions.js";

const parseNum = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Free capacity from stored slot fields (non-sowing slots after booked changes).
 * available = totalPlants − totalBookedPlants − bufferAmount (never below 0).
 */
export function computeAvailableFromBooked(slot) {
  const total = parseNum(slot?.totalPlants);
  const booked = parseNum(slot?.totalBookedPlants);
  const bufferAmount = parseNum(slot?.bufferAmount);
  return Math.max(0, total - booked - bufferAmount);
}

/** Booked plants from live orders (same rules as Slots View / transfer pre-check). */
export async function sumBookedPlantsForSlot(slotId, session) {
  const slotOid =
    typeof slotId === "string" ? new mongoose.Types.ObjectId(slotId) : slotId;

  const pipeline = [
    {
      $match: {
        bookingSlot: slotOid,
        orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
        $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }],
      },
    },
    { $group: { _id: null, total: { $sum: "$numberOfPlants" } } },
  ];

  let agg = Order.aggregate(pipeline);
  if (session) agg = agg.session(session);
  const rows = await agg;
  return parseNum(rows[0]?.total);
}

export function computeAvailableOverflowFromBooked(slot, bookedOverride) {
  const total = parseNum(slot?.totalPlants);
  const booked =
    bookedOverride !== undefined ? parseNum(bookedOverride) : parseNum(slot?.totalBookedPlants);
  const bufferAmount = parseNum(slot?.bufferAmount);
  const raw = total - booked - bufferAmount;
  return {
    availablePlants: raw,
    isOverflow: raw < 0,
    totalBookedPlants: booked,
    totalPlants: Math.max(0, Math.max(0, raw) + booked),
  };
}

/**
 * Update in-memory slot counters for order transfer (matches DB moveOrderBetweenSlots).
 */
export function applyOrderTransferToSlotMemory(slot, plantsCount, direction) {
  if (!slot) return;
  const qty = parseNum(plantsCount);
  if (qty <= 0) return;

  const bookedDelta = direction === "release" ? -qty : qty;
  slot.totalBookedPlants = parseNum(slot.totalBookedPlants) + bookedDelta;
  slot.availablePlants = computeAvailableFromBooked(slot);
}

/**
 * Persist availablePlants from booked totals after order transfer.
 * Always runs so materialized availablePlants stays in sync with booked (UI reads both).
 */
export async function reconcileSlotAvailablePlants(
  slotId,
  session,
  { plantSlotId, subtypeId } = {}
) {
  const slotOid =
    typeof slotId === "string" ? new mongoose.Types.ObjectId(slotId) : slotId;

  const found = await findSlotSubdocumentById(slotId, session);
  if (!found?.slot) return null;

  const plantSlotOid = plantSlotId
    ? new mongoose.Types.ObjectId(plantSlotId.toString())
    : new mongoose.Types.ObjectId(found.plantSlotId.toString());
  const subtypeOid = subtypeId
    ? new mongoose.Types.ObjectId(subtypeId.toString())
    : new mongoose.Types.ObjectId(found.subtypeId.toString());

  const bookedFromOrders = await sumBookedPlantsForSlot(slotId, session);
  const { availablePlants: newAvailable, isOverflow, totalPlants: newTotalPlants } =
    computeAvailableOverflowFromBooked(found.slot, bookedFromOrders);

  const updateOptions = {
    arrayFilters: [{ "st.subtypeId": subtypeOid }, { "sl._id": slotOid }],
  };
  if (session) updateOptions.session = session;

  const result = await PlantSlot.updateOne(
    { _id: plantSlotOid },
    {
      $set: {
        "subtypeSlots.$[st].slots.$[sl].availablePlants": newAvailable,
        "subtypeSlots.$[st].slots.$[sl].totalBookedPlants": bookedFromOrders,
        "subtypeSlots.$[st].slots.$[sl].totalPlants": newTotalPlants,
        "subtypeSlots.$[st].slots.$[sl].availablePlantsMaterialized": true,
        "subtypeSlots.$[st].slots.$[sl].isOverflow": isOverflow,
        "subtypeSlots.$[st].slots.$[sl].overflow": isOverflow,
      },
    },
    updateOptions
  );

  if (result.matchedCount === 0 || result.modifiedCount === 0) {
    throw new Error(`Failed to reconcile available plants for slot ${slotOid}`);
  }

  return {
    availablePlants: newAvailable,
    totalBookedPlants: bookedFromOrders,
    totalPlants: newTotalPlants,
    isOverflow,
  };
}

/**
 * Full slot state snapshot for transfer trail before/after blocks.
 */
export function buildSlotSnapshot(slot) {
  if (!slot) {
    return {
      primarySowed: 0,
      officeSowed: 0,
      totalPlants: 0,
      availablePlants: 0,
      excessivePlants: 0,
      plantsSowed: 0,
      totalBookedPlants: 0,
      inProgressCount: 0,
      actualPlants: 0,
      closingStock: 0,
    };
  }

  const totalPlants = parseNum(slot.totalPlants);
  const availablePlants =
    slot.availablePlants !== undefined && slot.availablePlants !== null
      ? parseNum(slot.availablePlants)
      : totalPlants;

  return {
    primarySowed: parseNum(slot.primarySowed),
    officeSowed: parseNum(slot.officeSowed),
    totalPlants,
    availablePlants,
    excessivePlants: parseNum(slot.excessiveSowing?.plants),
    plantsSowed: parseNum(slot.plantsSowed),
    totalBookedPlants: parseNum(slot.totalBookedPlants),
    inProgressCount: Array.isArray(slot.sowingInProgress) ? slot.sowingInProgress.length : 0,
    actualPlants: parseNum(slot.actualPlants),
    closingStock: parseNum(slot.closingStock),
  };
}

const emptyPlusMinus = () => ({
  plus: {
    primarySowed: 0,
    officeSowed: 0,
    totalPlants: 0,
    availablePlants: 0,
    excessivePlants: 0,
    packetsUsed: 0,
    plantsSowed: 0,
    gapCovered: 0,
  },
  minus: {
    packetsRemaining: 0,
    inProgressEntries: 0,
  },
});

/**
 * Push a transfer trail entry onto a slot via MongoDB update.
 */
export async function appendTransferSlotTrail({
  slotId,
  action,
  quantity,
  performedBy,
  notes,
  reason,
  metadata = {},
  before,
  after,
  orderId = null,
  bufferPercentage = 0,
  bufferAmount = 0,
  session,
}) {
  const activityName = getSlotTrailActivityName(action);
  const beforeSnap = before || {};
  const afterSnap = after || {};
  const { plus, minus } = emptyPlusMinus();

  const now = new Date();
  const trailEntry = {
    action,
    activityName,
    quantity: parseNum(quantity),
    orderId: orderId || null,
    performedBy: performedBy || null,
    notes: notes || "",
    reason: reason || activityName,
    previousTotalPlants: parseNum(beforeSnap.totalPlants),
    newTotalPlants: parseNum(afterSnap.totalPlants),
    previousAvailablePlants: parseNum(beforeSnap.availablePlants),
    newAvailablePlants: parseNum(afterSnap.availablePlants),
    bufferPercentage: parseNum(bufferPercentage),
    bufferAmount: parseNum(bufferAmount),
    plus,
    minus,
    before: beforeSnap,
    after: afterSnap,
    metadata,
    createdAt: now,
    updatedAt: now,
  };

  const slotOid =
    typeof slotId === "string" ? new mongoose.Types.ObjectId(slotId) : slotId;

  const updateOptions = {
    arrayFilters: [{ "subtypeSlot.slots._id": slotOid }, { "slot._id": slotOid }],
  };
  if (session) {
    updateOptions.session = session;
  }

  await PlantSlot.updateOne(
    { "subtypeSlots.slots._id": slotOid },
    {
      $push: {
        "subtypeSlots.$[subtypeSlot].slots.$[slot].slotTrail": {
          $each: [trailEntry],
          $position: 0,
          $slice: 1000,
        },
      },
    },
    updateOptions
  );
}

/**
 * Load a single slot subdocument by slot _id (for post-transfer snapshots).
 */
export async function findSlotSubdocumentById(slotId, session) {
  const oid = slotId;
  let query = PlantSlot.findOne({ "subtypeSlots.slots._id": oid }).lean();
  if (session) {
    query = query.session(session);
  }
  const doc = await query;
  if (!doc) return null;

  for (const st of doc.subtypeSlots || []) {
    const slot = (st.slots || []).find((s) => s._id?.toString() === oid.toString());
    if (slot) {
      return {
        plantSlotId: doc._id,
        subtypeId: st.subtypeId,
        plantSlotYear: doc.year,
        slot,
      };
    }
  }
  return null;
}
