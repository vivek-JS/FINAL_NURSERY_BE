import mongoose from "mongoose";
import Order from "../models/order.model.js";
import PlantSlot from "../models/slots.model.js";
import {
  deliveryDateToIstMoment,
  slotDayStartMoment,
} from "../utility/istSlotDate.js";
import {
  resolveDestinationSlot,
  orderPlantsNeed,
} from "../controllers/orderSowFromExcess.controller.js";
import { writeTransferAudit } from "../controllers/sowingTransferAudit.helpers.js";
import { recordSlotTrail } from "../utility/slotTrailStore.js";
import { splitLagwadQtyForSlot } from "../utility/lagwadSlotPlantsSplit.js";
import {
  SLOT_TRAIL_ACTIONS,
  getSlotTrailActivityName,
} from "../constants/slotTrailActions.js";

export const EXCESS_COVER_WINDOW_DAYS = 5;

export class ExcessCoverError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function toOid(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  const s = String(id?._id || id);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

function int(n) {
  return Math.max(0, Math.floor(Number(n) || 0));
}

function offsetLabel(off) {
  if (off === 0) return "0d";
  return off > 0 ? `+${off}d` : `${off}d`;
}

function shortDay(ddMmYyyy) {
  return String(ddMmYyyy || "").slice(0, 5) || "—";
}

function slotLabel(slot) {
  if (!slot?.startDay) return "—";
  if (!slot.endDay || slot.startDay === slot.endDay) return slot.startDay;
  return `${slot.startDay} → ${slot.endDay}`;
}

function windowDayStrings(deliveryIst, windowDays) {
  const days = [];
  for (let o = -windowDays; o <= windowDays; o += 1) {
    days.push(deliveryIst.clone().add(o, "days").format("DD-MM-YYYY"));
  }
  return days;
}

function readyMomentOf(batch, slot) {
  const fromBatch = slotDayStartMoment(batch?.plantReadyDate);
  if (fromBatch) return fromBatch;
  return slotDayStartMoment(slot?.startDay);
}

/**
 * Free excess in sowing batches of plant+subtype whose ready date is within
 * delivery ±windowDays (IST). One entry per batch, nearest to delivery first.
 * Per slot free = primarySowed − gross orderCoveredPlants (same as slot "Can book");
 * stored availablePlants does not cap it.
 */
export async function listExcessBatches({
  plantId,
  subtypeId,
  deliveryDate,
  need = 0,
  windowDays = EXCESS_COVER_WINDOW_DAYS,
}) {
  const plantOid = toOid(plantId);
  const subtypeOid = toOid(subtypeId);
  const deliveryIst = deliveryDateToIstMoment(deliveryDate);
  const needQty = int(need);
  const win = Math.min(15, Math.max(0, Math.floor(Number(windowDays) || 0)));
  const empty = { need: needQty, windowDays: win, totalFree: 0, mode: "none", entries: [] };
  if (!plantOid || !subtypeOid || !deliveryIst) return empty;

  const days = windowDayStrings(deliveryIst, win);
  const rows = await PlantSlot.aggregate([
    { $match: { plantId: plantOid } },
    { $unwind: "$subtypeSlots" },
    { $match: { "subtypeSlots.subtypeId": subtypeOid } },
    { $unwind: "$subtypeSlots.slots" },
    {
      $match: {
        "subtypeSlots.slots.sowingBatches.0": { $exists: true },
        $or: [
          { "subtypeSlots.slots.startDay": { $in: days } },
          { "subtypeSlots.slots.sowingBatches.plantReadyDate": { $in: days } },
        ],
      },
    },
    {
      $project: {
        _id: 0,
        slotId: "$subtypeSlots.slots._id",
        startDay: "$subtypeSlots.slots.startDay",
        endDay: "$subtypeSlots.slots.endDay",
        primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
        availablePlants: { $ifNull: ["$subtypeSlots.slots.availablePlants", 0] },
        excessivePlants: {
          $ifNull: ["$subtypeSlots.slots.excessiveSowing.plants", 0],
        },
        batches: {
          $map: {
            input: "$subtypeSlots.slots.sowingBatches",
            as: "b",
            in: {
              _id: "$$b._id",
              sowedAt: "$$b.sowedAt",
              sowingDate: "$$b.sowingDate",
              plantReadyDate: "$$b.plantReadyDate",
              plantsSowed: { $ifNull: ["$$b.plantsSowed", 0] },
              orderCoveredPlants: { $ifNull: ["$$b.orderCoveredPlants", 0] },
              excessPlants: { $ifNull: ["$$b.excessPlants", 0] },
              actualPlantsApplied: "$$b.actualPlantsApplied",
              expectedMortalityApplied: "$$b.expectedMortalityApplied",
              availablePlantsApplied: "$$b.availablePlantsApplied",
              shedName: "$$b.shedName",
              requestNumber: "$$b.requestNumber",
              sowingRequestId: "$$b.sowingRequestId",
            },
          },
        },
      },
    },
  ]);

  const entries = [];
  for (const slot of rows) {
    const batches = slot.batches || [];
    const gross = batches.reduce((s, b) => s + int(b.orderCoveredPlants), 0);
    const primarySowed = int(slot.primarySowed);
    const excessForBooking = primarySowed > 0 ? Math.max(0, primarySowed - gross) : 0;
    let slotCap = excessForBooking;
    if (slotCap <= 0) continue;

    const ordered = [...batches].sort(
      (a, b) => new Date(a.sowedAt || 0) - new Date(b.sowedAt || 0)
    );
    for (const b of ordered) {
      if (slotCap <= 0) break;
      const sowed = int(b.plantsSowed);
      if (sowed <= 0) continue;
      const rawFree = Math.max(0, sowed - int(b.orderCoveredPlants));
      if (rawFree <= 0) continue;
      const ready = readyMomentOf(b, slot);
      if (!ready) continue;
      const offsetDays = ready.diff(deliveryIst, "days");
      if (Math.abs(offsetDays) > win) continue;
      const freePlants = Math.min(rawFree, slotCap);
      slotCap -= freePlants;
      entries.push({
        slotId: String(slot.slotId),
        batchId: String(b._id),
        slotLabel: slotLabel(slot),
        sowingDate: b.sowingDate || "",
        plantReadyDate: b.plantReadyDate || slot.startDay || "",
        offsetDays,
        offsetLabel: offsetLabel(offsetDays),
        shedName: b.shedName || "",
        requestNumber: b.requestNumber || "",
        sowingRequestId: b.sowingRequestId ? String(b.sowingRequestId) : null,
        freePlants,
        plantsSowed: sowed,
        orderCoveredPlants: int(b.orderCoveredPlants),
        batchExcessPlants: int(b.excessPlants),
        batchActualApplied: b.actualPlantsApplied == null ? null : int(b.actualPlantsApplied),
        batchMortalityApplied:
          b.expectedMortalityApplied == null ? null : int(b.expectedMortalityApplied),
        batchAvailableApplied:
          b.availablePlantsApplied == null ? null : int(b.availablePlantsApplied),
        sowedAt: b.sowedAt || null,
        slotAvailablePlants: int(slot.availablePlants),
        slotExcessivePlants: int(slot.excessivePlants),
      });
    }
  }

  entries.sort(
    (a, b) =>
      Math.abs(a.offsetDays) - Math.abs(b.offsetDays) || a.offsetDays - b.offsetDays
  );
  const totalFree = entries.reduce((s, e) => s + e.freePlants, 0);
  let mode = "none";
  if (totalFree > 0) mode = needQty > 0 && totalFree >= needQty ? "full" : "partial";
  return { need: needQty, windowDays: win, totalFree, mode, entries };
}

/** Merge duplicate batch picks; drops zero rows. */
export function normalizePicks(picks) {
  let list = picks;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  const byBatch = new Map();
  for (const p of list) {
    const batchId = toOid(p?.batchId);
    const slotId = toOid(p?.slotId);
    const plants = int(p?.plants);
    if (!batchId || !slotId || plants <= 0) continue;
    const key = String(batchId);
    const prev = byBatch.get(key);
    if (prev) prev.plants += plants;
    else byBatch.set(key, { batchId: key, slotId: String(slotId), plants });
  }
  return [...byBatch.values()];
}

/**
 * Check picks against live free excess. Returns the matched preview entries.
 * Throws ExcessCoverError when they no longer fit.
 */
export async function validateCoverPicks({
  plantId,
  subtypeId,
  deliveryDate,
  need,
  picks,
  windowDays = EXCESS_COVER_WINDOW_DAYS,
}) {
  const needQty = int(need);
  const list = normalizePicks(picks);
  if (!list.length) {
    throw new ExcessCoverError("NO_PICKS", "Select at least one sowing batch to cover the order");
  }
  const sum = list.reduce((s, p) => s + p.plants, 0);
  if (needQty <= 0 || sum !== needQty) {
    throw new ExcessCoverError(
      "PICKS_MISMATCH",
      `Selected plants (${sum}) must equal order quantity (${needQty})`
    );
  }
  const preview = await listExcessBatches({
    plantId,
    subtypeId,
    deliveryDate,
    need: needQty,
    windowDays,
  });
  const byBatch = new Map(preview.entries.map((e) => [e.batchId, e]));
  const matched = list.map((p) => {
    const entry = byBatch.get(p.batchId);
    if (!entry || entry.slotId !== p.slotId || p.plants > entry.freePlants) {
      throw new ExcessCoverError(
        "INSUFFICIENT_BATCH_EXCESS",
        entry
          ? `Batch ${entry.requestNumber || entry.plantReadyDate} has only ${entry.freePlants} free plants now`
          : "A selected sowing batch no longer has free excess",
        409
      );
    }
    return { ...entry, take: p.plants };
  });
  return { picks: matched, preview };
}

const SLOT_PATH = "subtypeSlots.$[st].slots.$[sl]";
const BATCH_PATH = `${SLOT_PATH}.sowingBatches.$[b]`;

/** Positional filters for a batch matched by id only (it may have moved slot since). */
function batchFilters(batchOid) {
  return [
    { "st.slots.sowingBatches._id": batchOid },
    { "sl.sowingBatches._id": batchOid },
    { "b._id": batchOid },
  ];
}

function batchExistsFilter(batchOid, extra = {}) {
  return {
    subtypeSlots: {
      $elemMatch: {
        slots: { $elemMatch: { sowingBatches: { $elemMatch: { _id: batchOid, ...extra } } } },
      },
    },
  };
}

/**
 * Take plants from a source batch.
 * Same slot as the booking → batch.orderCoveredPlants += take (plants stay).
 * Other slot → plants move: source batch/slot sowed −take; a real sow entry with the
 * same sowing date is added on the booking slot (covered, not saleable).
 */
async function applySourcePick({
  pick,
  destination,
  orderOid,
  userOid,
  now,
  excessiveLeft,
  availableLeft,
  session,
}) {
  const slotOid = toOid(pick.slotId);
  const batchOid = toOid(pick.batchId);
  const take = pick.take;
  const moved = String(pick.slotId) !== String(destination.slotId);
  const excessDec = Math.min(take, Math.max(0, excessiveLeft));
  const availDec = Math.min(take, Math.max(0, availableLeft));
  const batchExcessDec = Math.min(take, int(pick.batchExcessPlants));
  const maxCoveredBefore = pick.plantsSowed - take;
  const split = splitLagwadQtyForSlot(take);
  const batchActualDec =
    moved && pick.batchActualApplied != null ? Math.min(split.actualPlants, pick.batchActualApplied) : 0;
  const batchMortalityDec =
    moved && pick.batchMortalityApplied != null
      ? Math.min(split.expectedMortality, pick.batchMortalityApplied)
      : 0;
  const batchAvailableDec =
    moved && pick.batchAvailableApplied != null ? Math.min(availDec, pick.batchAvailableApplied) : 0;
  const actualDec = !moved ? 0 : pick.batchActualApplied != null ? batchActualDec : split.actualPlants;
  const mortalityDec = !moved
    ? 0
    : pick.batchMortalityApplied != null
      ? batchMortalityDec
      : split.expectedMortality;

  const batchMatch = {
    _id: batchOid,
    $or: [
      { orderCoveredPlants: { $lte: maxCoveredBefore } },
      { orderCoveredPlants: { $exists: false } },
      { orderCoveredPlants: null },
    ],
  };
  if (moved) batchMatch.plantsSowed = pick.plantsSowed;
  const slotMatch = { _id: slotOid, sowingBatches: { $elemMatch: batchMatch } };
  if (excessDec > 0) slotMatch["excessiveSowing.plants"] = { $gte: excessDec };
  if (availDec > 0) slotMatch.availablePlants = { $gte: availDec };

  const inc = {};
  if (moved) {
    inc[`${SLOT_PATH}.primarySowed`] = -take;
    inc[`${SLOT_PATH}.plantsSowed`] = -take;
    inc[`${SLOT_PATH}.totalPlants`] = -take;
    if (actualDec > 0) inc[`${SLOT_PATH}.actualPlants`] = -actualDec;
    if (mortalityDec > 0) inc[`${SLOT_PATH}.expectedMortality`] = -mortalityDec;
    inc[`${BATCH_PATH}.plantsSowed`] = -take;
    if (batchActualDec > 0) inc[`${BATCH_PATH}.actualPlantsApplied`] = -batchActualDec;
    if (batchMortalityDec > 0) inc[`${BATCH_PATH}.expectedMortalityApplied`] = -batchMortalityDec;
    if (batchAvailableDec > 0) inc[`${BATCH_PATH}.availablePlantsApplied`] = -batchAvailableDec;
  } else {
    inc[`${BATCH_PATH}.orderCoveredPlants`] = take;
  }
  if (availDec > 0) inc[`${SLOT_PATH}.availablePlants`] = -availDec;
  if (excessDec > 0) inc[`${SLOT_PATH}.excessiveSowing.plants`] = -excessDec;
  if (batchExcessDec > 0) inc[`${BATCH_PATH}.excessPlants`] = -batchExcessDec;

  const res = await PlantSlot.collection.updateOne(
    { subtypeSlots: { $elemMatch: { slots: { $elemMatch: slotMatch } } } },
    {
      $inc: inc,
      $push: {
        [`${BATCH_PATH}.excessAllocations`]: {
          _id: new mongoose.Types.ObjectId(),
          orderId: orderOid,
          plants: take,
          at: now,
          by: userOid,
        },
      },
      $addToSet: { [`${BATCH_PATH}.linkedOrderIds`]: orderOid },
    },
    {
      arrayFilters: [{ "st.slots._id": slotOid }, { "sl._id": slotOid }, { "b._id": batchOid }],
      ...(session ? { session } : {}),
    }
  );
  if (!res.matchedCount) return null;

  const applied = {
    moved,
    excessDec,
    availDec,
    batchExcessDec,
    actualDec,
    mortalityDec,
    batchActualDec,
    batchMortalityDec,
    batchAvailableDec,
    destSlotId: null,
    destBatchId: null,
  };
  if (!moved) return applied;

  const destSlotOid = toOid(destination.slotId);
  const destBatchId = new mongoose.Types.ObjectId();
  const destRes = await PlantSlot.collection.updateOne(
    { "subtypeSlots.slots._id": destSlotOid },
    {
      $inc: {
        [`${SLOT_PATH}.primarySowed`]: take,
        [`${SLOT_PATH}.plantsSowed`]: take,
        [`${SLOT_PATH}.totalPlants`]: take,
        [`${SLOT_PATH}.actualPlants`]: split.actualPlants,
        [`${SLOT_PATH}.expectedMortality`]: split.expectedMortality,
      },
      $push: {
        [`${SLOT_PATH}.sowingBatches`]: {
          _id: destBatchId,
          sowedAt: pick.sowedAt ? new Date(pick.sowedAt) : now,
          sowingDate: pick.sowingDate || "",
          plantReadyDate: pick.plantReadyDate || "",
          plantsSowed: take,
          packetsUsed: 0,
          orderCoveredPlants: take,
          excessPlants: 0,
          actualPlantsApplied: split.actualPlants,
          expectedMortalityApplied: split.expectedMortality,
          availablePlantsApplied: 0,
          orderReservedPlantsApplied: take,
          shedName: pick.shedName || "",
          isExcessiveSowing: false,
          linkedOrderIds: [orderOid],
          coverMovedFrom: { slotId: slotOid, batchId: batchOid },
          slotHistory: [
            {
              at: now,
              by: userOid,
              fromSlotId: slotOid,
              toSlotId: destSlotOid,
              fromReadyDate: pick.plantReadyDate || "",
              toReadyDate: destination.label || "",
              sowDate: pick.sowingDate || "",
              plantsSowed: take,
              reason: "EXCESS_COVER_MOVE",
            },
          ],
        },
      },
    },
    {
      arrayFilters: [{ "st.slots._id": destSlotOid }, { "sl._id": destSlotOid }],
      ...(session ? { session } : {}),
    }
  );
  applied.destSlotId = String(destSlotOid);
  applied.destBatchId = String(destBatchId);
  if (!destRes.matchedCount) {
    applied.destSlotId = null;
    applied.destBatchId = null;
    await revertSourcePick({ batchId: pick.batchId, plants: take, ...applied, orderOid, session });
    return null;
  }
  return applied;
}

/** Undo one source pick (and remove the moved sow entry from the booking slot). */
async function revertSourcePick({
  batchId,
  plants,
  moved = false,
  excessDec = 0,
  availDec = 0,
  batchExcessDec = 0,
  actualDec = 0,
  mortalityDec = 0,
  batchActualDec = 0,
  batchMortalityDec = 0,
  batchAvailableDec = 0,
  destBatchId = null,
  orderOid,
  session,
}) {
  const batchOid = toOid(batchId);
  if (!batchOid || plants <= 0) return false;
  const opts = session ? { session } : {};

  const inc = {};
  if (moved) {
    inc[`${SLOT_PATH}.primarySowed`] = plants;
    inc[`${SLOT_PATH}.plantsSowed`] = plants;
    inc[`${SLOT_PATH}.totalPlants`] = plants;
    if (actualDec > 0) inc[`${SLOT_PATH}.actualPlants`] = actualDec;
    if (mortalityDec > 0) inc[`${SLOT_PATH}.expectedMortality`] = mortalityDec;
    inc[`${BATCH_PATH}.plantsSowed`] = plants;
    if (batchActualDec > 0) inc[`${BATCH_PATH}.actualPlantsApplied`] = batchActualDec;
    if (batchMortalityDec > 0) inc[`${BATCH_PATH}.expectedMortalityApplied`] = batchMortalityDec;
    if (batchAvailableDec > 0) inc[`${BATCH_PATH}.availablePlantsApplied`] = batchAvailableDec;
  } else {
    inc[`${BATCH_PATH}.orderCoveredPlants`] = -plants;
  }
  if (availDec > 0) inc[`${SLOT_PATH}.availablePlants`] = availDec;
  if (excessDec > 0) inc[`${SLOT_PATH}.excessiveSowing.plants`] = excessDec;
  if (batchExcessDec > 0) inc[`${BATCH_PATH}.excessPlants`] = batchExcessDec;

  const res = await PlantSlot.collection.updateOne(
    batchExistsFilter(batchOid, moved ? {} : { orderCoveredPlants: { $gte: plants } }),
    {
      $inc: inc,
      $pull: {
        [`${BATCH_PATH}.excessAllocations`]: { orderId: orderOid },
        [`${BATCH_PATH}.linkedOrderIds`]: orderOid,
      },
    },
    { arrayFilters: batchFilters(batchOid), ...opts }
  );

  const destOid = toOid(destBatchId);
  if (moved && destOid) {
    const split = splitLagwadQtyForSlot(plants);
    await PlantSlot.collection.updateOne(
      batchExistsFilter(destOid),
      {
        $inc: {
          [`${SLOT_PATH}.primarySowed`]: -plants,
          [`${SLOT_PATH}.plantsSowed`]: -plants,
          [`${SLOT_PATH}.totalPlants`]: -plants,
          [`${SLOT_PATH}.actualPlants`]: -(actualDec || split.actualPlants),
          [`${SLOT_PATH}.expectedMortality`]: -(mortalityDec || split.expectedMortality),
        },
        $pull: { [`${SLOT_PATH}.sowingBatches`]: { _id: destOid } },
      },
      {
        arrayFilters: [
          { "st.slots.sowingBatches._id": destOid },
          { "sl.sowingBatches._id": destOid },
        ],
        ...opts,
      }
    );
  }
  return res.matchedCount > 0;
}

/** Older covers left a 0-plant pointer entry on the booking slot; drop it on reverse. */
async function removeCoverPointerBatches(sowingRequestId, session) {
  const reqOid = toOid(sowingRequestId);
  if (!reqOid) return;
  await PlantSlot.collection.updateMany(
    {
      "subtypeSlots.slots.sowingBatches": {
        $elemMatch: { sowingRequestId: reqOid, plantsSowed: 0 },
      },
    },
    {
      $pull: {
        "subtypeSlots.$[].slots.$[].sowingBatches": { sowingRequestId: reqOid, plantsSowed: 0 },
      },
    },
    session ? { session } : {}
  );
}

/** Tag moved sow entries with the cover's audit request (shows on slot sow entries). */
async function tagMovedBatches(applied, request, session) {
  for (const a of applied) {
    const destOid = toOid(a.destBatchId);
    if (!destOid || !request?._id) continue;
    await PlantSlot.collection.updateOne(
      batchExistsFilter(destOid),
      {
        $set: {
          [`${BATCH_PATH}.sowingRequestId`]: request._id,
          [`${BATCH_PATH}.requestNumber`]: request.requestNumber,
        },
        $addToSet: { [`${SLOT_PATH}.linkedSowingRequests`]: request._id },
      },
      {
        arrayFilters: [
          { "st.slots.sowingBatches._id": destOid },
          { "sl.sowingBatches._id": destOid },
          { "b._id": destOid },
        ],
        ...(session ? { session } : {}),
      }
    );
  }
}

async function incDestinationReserved(slotId, delta, session) {
  const slotOid = toOid(slotId);
  if (!slotOid || !delta) return true;
  const filter =
    delta < 0
      ? {
          subtypeSlots: {
            $elemMatch: {
              slots: { $elemMatch: { _id: slotOid, orderReservedPlants: { $gte: -delta } } },
            },
          },
        }
      : { "subtypeSlots.slots._id": slotOid };
  const res = await PlantSlot.collection.updateOne(
    filter,
    { $inc: { [`${SLOT_PATH}.orderReservedPlants`]: delta } },
    {
      arrayFilters: [{ "st.slots._id": slotOid }, { "sl._id": slotOid }],
      ...(session ? { session } : {}),
    }
  );
  if (res.matchedCount || delta > 0) return res.matchedCount > 0;
  await PlantSlot.collection.updateOne(
    { "subtypeSlots.slots._id": slotOid },
    { $set: { [`${SLOT_PATH}.orderReservedPlants`]: 0 } },
    {
      arrayFilters: [{ "st.slots._id": slotOid }, { "sl._id": slotOid }],
      ...(session ? { session } : {}),
    }
  );
  return true;
}

function coverRemark(sources) {
  const byDate = new Map();
  for (const s of sources) {
    const key = `${s.sowingDate}|${s.plantReadyDate}`;
    const prev = byDate.get(key);
    if (prev) prev.plants += Number(s.plants) || 0;
    else byDate.set(key, { ...s, plants: Number(s.plants) || 0 });
  }
  const parts = [...byDate.values()].map(
    (s) =>
      `sowed ${shortDay(s.sowingDate)} (ready ${shortDay(s.plantReadyDate)}, ${offsetLabel(s.offsetDays)}) ${s.plants.toLocaleString("en-IN")}`
  );
  return `Sow completed from excess: ${parts.join(", ")}`;
}

/**
 * Cover a booked order from picked sowing batches: source batch cover, destination
 * orderReserved, order sowingDone + sowingCoverSources, audit request and trail rows.
 */
export async function coverOrderFromBatches({ order: orderInput, picks, userId, quiet = false }) {
  const orderOid = toOid(orderInput?._id || orderInput);
  if (!orderOid) throw new ExcessCoverError("ORDER_NOT_FOUND", "Order not found", 404);
  const order = await Order.findById(orderOid)
    .select(
      "orderId plantName plantSubtype deliveryDate bookingSlot numberOfPlants additionalPlants sowingDone orderStatus productMappingId"
    )
    .lean();
  if (!order) throw new ExcessCoverError("ORDER_NOT_FOUND", "Order not found", 404);
  if (order.sowingDone) {
    throw new ExcessCoverError("ALREADY_SOWED", "Order is already marked sow completed", 409);
  }

  const need = orderPlantsNeed(order);
  const { picks: matched } = await validateCoverPicks({
    plantId: order.plantName,
    subtypeId: order.plantSubtype,
    deliveryDate: order.deliveryDate,
    need,
    picks,
  });

  const destination = await resolveDestinationSlot({
    plantId: String(order.plantName),
    subtypeId: String(order.plantSubtype),
    deliveryDate: order.deliveryDate,
    bookingSlotId: order.bookingSlot,
  });
  if (!destination?.slotId) {
    throw new ExcessCoverError("NO_DESTINATION", "Could not find the order's booking slot");
  }

  const userOid = toOid(userId);
  const now = new Date();
  const excessiveLeftBySlot = new Map();
  const availableLeftBySlot = new Map();
  const applied = [];

  const rollback = async (withDestination) => {
    for (const a of applied.reverse()) {
      try {
        await revertSourcePick({ ...a, orderOid });
      } catch (err) {
        console.error("[excessCover] rollback source failed:", err?.message || err);
      }
    }
    if (withDestination) {
      try {
        await incDestinationReserved(destination.slotId, -need);
      } catch (err) {
        console.error("[excessCover] rollback destination failed:", err?.message || err);
      }
    }
  };

  for (const pick of matched) {
    if (!excessiveLeftBySlot.has(pick.slotId)) {
      excessiveLeftBySlot.set(pick.slotId, pick.slotExcessivePlants);
    }
    if (!availableLeftBySlot.has(pick.slotId)) {
      availableLeftBySlot.set(pick.slotId, pick.slotAvailablePlants);
    }
    const excessiveLeft = excessiveLeftBySlot.get(pick.slotId);
    const availableLeft = availableLeftBySlot.get(pick.slotId);
    const res = await applySourcePick({
      pick,
      destination,
      orderOid,
      userOid,
      now,
      excessiveLeft,
      availableLeft,
    });
    if (!res) {
      await rollback(false);
      throw new ExcessCoverError(
        "INSUFFICIENT_BATCH_EXCESS",
        `Batch ${pick.requestNumber || pick.plantReadyDate} no longer has ${pick.take} free plants`,
        409
      );
    }
    excessiveLeftBySlot.set(pick.slotId, excessiveLeft - res.excessDec);
    availableLeftBySlot.set(pick.slotId, availableLeft - res.availDec);
    applied.push({ ...res, slotId: pick.slotId, batchId: pick.batchId, plants: pick.take });
  }

  const destOk = await incDestinationReserved(destination.slotId, need);
  if (!destOk) {
    await rollback(false);
    throw new ExcessCoverError("NO_DESTINATION", "Could not update the order's booking slot");
  }

  const sources = matched.map((p, i) => ({
    slotId: toOid(p.slotId),
    batchId: toOid(p.batchId),
    sowingRequestId: toOid(p.sowingRequestId),
    requestNumber: p.requestNumber || "",
    plants: p.take,
    sowingDate: p.sowingDate || "",
    plantReadyDate: p.plantReadyDate || "",
    shedName: p.shedName || "",
    offsetDays: p.offsetDays,
    excessiveSowingDec: applied[i].excessDec,
    availablePlantsDec: applied[i].availDec,
    batchExcessDec: applied[i].batchExcessDec,
    moved: applied[i].moved,
    destSlotId: toOid(applied[i].destSlotId),
    destBatchId: toOid(applied[i].destBatchId),
    actualPlantsDec: applied[i].actualDec,
    expectedMortalityDec: applied[i].mortalityDec,
    batchActualAppliedDec: applied[i].batchActualDec,
    batchMortalityAppliedDec: applied[i].batchMortalityDec,
    batchAvailableAppliedDec: applied[i].batchAvailableDec,
  }));
  const remark = coverRemark(sources);

  const marked = await Order.findOneAndUpdate(
    { _id: orderOid, sowingDone: { $ne: true } },
    {
      $set: {
        sowingDone: true,
        sowingDoneAt: now,
        sowingCoverSources: sources,
      },
      $unset: { sowingCoverReversedAt: "" },
      ...(quiet ? {} : { $push: { orderRemarks: remark } }),
    },
    { new: true }
  );
  if (!marked) {
    await rollback(true);
    throw new ExcessCoverError("ALREADY_SOWED", "Order is already marked sow completed", 409);
  }

  let request = null;
  try {
    request = await writeTransferAudit({
      order,
      plants: need,
      transfers: matched.map((p) => ({
        fromSlotId: p.slotId,
        fromLabel: p.plantReadyDate || p.slotLabel,
        toLabel: destination.label,
        take: p.take,
        offsetDays: p.offsetDays,
        sameSlot: String(p.slotId) === String(destination.slotId),
      })),
      destination,
      userId,
      note: "Cover order from excess sowing batches",
      destCountsAsCovered: false,
      skipDestBatch: true,
    });
    if (request?._id) {
      await Order.updateOne({ _id: orderOid }, { $set: { sowingDoneRequestId: request._id } });
      await tagMovedBatches(applied, request);
    }
  } catch (err) {
    console.error("[excessCover] audit write failed:", err?.message || err);
  }

  await writeCoverTrails({
    order,
    sources,
    destination,
    need,
    userId,
    action: SLOT_TRAIL_ACTIONS.ORDER_COVERED_FROM_EXCESS,
    at: now,
  });

  return {
    orderId: order.orderId,
    need,
    sowingDoneRequestId: request?._id || null,
    requestNumber: request?.requestNumber || null,
    sources,
    destination: { slotId: destination.slotId, label: destination.label },
    remark,
  };
}

async function writeCoverTrails({ order, sources, destination, need, userId, action, at, session }) {
  const reversed = action === SLOT_TRAIL_ACTIONS.ORDER_COVER_REVERSED;
  const activityName = getSlotTrailActivityName(action);
  const bySlot = new Map();
  for (const s of sources) {
    const key = String(s.slotId);
    bySlot.set(key, (bySlot.get(key) || 0) + (Number(s.plants) || 0));
  }
  const rows = [];
  for (const [slotId, plants] of bySlot) {
    rows.push([
      slotId,
      {
        at,
        timestamp: at,
        action,
        activityName,
        quantity: plants,
        plants,
        orderId: order.orderId,
        orderRef: order._id,
        role: "source",
        toSlotId: destination?.slotId || null,
        toLabel: destination?.label || "",
        performedBy: userId || null,
        reason: reversed
          ? `Order #${order.orderId} cancelled — ${plants} excess plants returned to batches`
          : `${plants} excess plants given to order #${order.orderId}`,
      },
    ]);
  }
  if (destination?.slotId) {
    rows.push([
      String(destination.slotId),
      {
        at,
        timestamp: at,
        action,
        activityName,
        quantity: need,
        plants: need,
        orderId: order.orderId,
        orderRef: order._id,
        role: "destination",
        performedBy: userId || null,
        reason: reversed
          ? `Order #${order.orderId} cover reversed — orderReserved −${need}`
          : `Order #${order.orderId} covered from excess batches — orderReserved +${need}`,
      },
    ]);
  }
  for (const [slotId, entry] of rows) {
    try {
      await recordSlotTrail(slotId, entry, session);
    } catch (err) {
      console.error("[excessCover] trail write failed:", err?.message || err);
    }
  }
}

/**
 * Undo coverOrderFromBatches (order cancel / reject). Safe to call twice.
 * Pass the cancel transaction's session to keep slot + order writes atomic.
 */
export async function reverseOrderBatchCover({ order, userId, session, quiet = false }) {
  const sources = Array.isArray(order?.sowingCoverSources) ? order.sowingCoverSources : [];
  if (!sources.length || order?.sowingCoverReversedAt) {
    return { reversed: false, sources: 0 };
  }
  const orderOid = toOid(order._id);
  const need = orderPlantsNeed(order);
  const destSlotId = order.bookingSlot?._id || order.bookingSlot;
  let auditRequestId = order.sowingDoneRequestId;
  if (auditRequestId === undefined) {
    const fresh = await Order.findById(orderOid)
      .select("sowingDoneRequestId")
      .session(session || null)
      .lean();
    auditRequestId = fresh?.sowingDoneRequestId;
  }

  for (const s of sources) {
    const ok = await revertSourcePick({
      batchId: s.batchId,
      plants: int(s.plants),
      moved: Boolean(s.moved),
      excessDec: int(s.excessiveSowingDec),
      availDec: s.availablePlantsDec == null ? int(s.plants) : int(s.availablePlantsDec),
      batchExcessDec: int(s.batchExcessDec),
      actualDec: int(s.actualPlantsDec),
      mortalityDec: int(s.expectedMortalityDec),
      batchActualDec: int(s.batchActualAppliedDec),
      batchMortalityDec: int(s.batchMortalityAppliedDec),
      batchAvailableDec: int(s.batchAvailableAppliedDec),
      destBatchId: s.destBatchId,
      orderOid,
      session,
    });
    if (!ok) {
      console.warn(
        `[excessCover] reverse: source slot ${s.slotId} batch ${s.batchId} not found for order #${order.orderId}`
      );
    }
  }
  const coveredTotal = sources.reduce((sum, s) => sum + int(s.plants), 0);
  await incDestinationReserved(destSlotId, -(coveredTotal || need), session);
  await removeCoverPointerBatches(auditRequestId, session);

  const at = new Date();
  await Order.collection.updateOne(
    { _id: orderOid },
    {
      $set: { sowingCoverReversedAt: at, sowingDone: false },
      $unset: { sowingDoneAt: "", sowingDoneRequestId: "" },
      ...(quiet
        ? {}
        : {
            $push: {
              orderRemarks: `Excess cover reversed: ${coveredTotal.toLocaleString("en-IN")} plants returned to sowing entries`,
            },
          }),
    },
    session ? { session } : undefined
  );

  if (quiet) return { reversed: true, sources: sources.length, plants: coveredTotal };

  await writeCoverTrails({
    order,
    sources,
    destination: destSlotId ? { slotId: destSlotId, label: "" } : null,
    need: coveredTotal || need,
    userId,
    action: SLOT_TRAIL_ACTIONS.ORDER_COVER_REVERSED,
    at,
    session,
  });

  return { reversed: true, sources: sources.length, plants: coveredTotal };
}
