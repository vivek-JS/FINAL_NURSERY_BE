import mongoose from "mongoose";
import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import {
  deliveryDateToIstMoment,
  slotDayStartMoment,
} from "../utility/istSlotDate.js";
import {
  resolveDestinationSlot,
  orderPlantsNeed,
} from "../controllers/orderSowFromExcess.controller.js";
import { toSowYmd } from "../controllers/sowingSlotReadyHelpers.js";
import { recordSlotTrail } from "../utility/slotTrailStore.js";
import { slotSowStock, sowBatchStock, splitLagwadQtyForSlot } from "../utility/lagwadSlotPlantsSplit.js";
import {
  SLOT_TRAIL_ACTIONS,
  getSlotTrailActivityName,
} from "../constants/slotTrailActions.js";

export const EXCESS_COVER_WINDOW_DAYS = 5;
export const DEFAULT_EXCESS_MAX_WINDOW_DAYS = 15;
/** Papaya ready dates sit further from delivery than watermelon. */
export const PAPAYA_EXCESS_WINDOW_DAYS = 40;

export function isPapayaPlantName(name) {
  return String(name || "").trim().toLowerCase() === "papaya";
}

/** ±15 for normal sowing plants; ±40 for papaya. */
export async function excessWindowCapForPlant(plantId) {
  const plant = await PlantCms.findById(toOid(plantId)).select("name").lean();
  return isPapayaPlantName(plant?.name)
    ? PAPAYA_EXCESS_WINDOW_DAYS
    : DEFAULT_EXCESS_MAX_WINDOW_DAYS;
}

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

/** Oldest sow day across the picked batches, as "YYYY-MM-DD" (null when none recorded). */
export function earliestSowYmd(picks) {
  const days = (picks || [])
    .map((p) => toSowYmd(p?.sowingDate || p?.sowedAt))
    .filter(Boolean)
    .sort();
  return days[0] || null;
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

function hasActiveExcessCover(order) {
  return (
    Array.isArray(order?.sowingCoverSources) &&
    order.sowingCoverSources.length > 0 &&
    !order.sowingCoverReversedAt
  );
}

/** Slot batches of the order's own (normal) sowing that still hold its plants, oldest first. */
async function findOwnSowBatches(order, session) {
  const reqOid = toOid(order?.sowingDoneRequestId);
  if (!reqOid) return [];
  const agg = PlantSlot.aggregate([
    { $match: { "subtypeSlots.slots.sowingBatches.sowingRequestId": reqOid } },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $unwind: "$subtypeSlots.slots.sowingBatches" },
    { $match: { "subtypeSlots.slots.sowingBatches.sowingRequestId": reqOid } },
    {
      $project: {
        _id: 0,
        slotId: "$subtypeSlots.slots._id",
        startDay: "$subtypeSlots.slots.startDay",
        endDay: "$subtypeSlots.slots.endDay",
        orderReservedPlants: { $ifNull: ["$subtypeSlots.slots.orderReservedPlants", 0] },
        batch: "$subtypeSlots.slots.sowingBatches",
      },
    },
  ]);
  if (session) agg.session(session);
  const rows = (await agg).filter(
    (r) => int(r.batch?.plantsSowed) > 0 && int(r.batch?.orderCoveredPlants) > 0
  );
  const orderKey = String(order._id);
  const linked = rows.filter((r) =>
    (r.batch.linkedOrderIds || []).some((id) => String(id) === orderKey)
  );
  return (linked.length ? linked : rows).sort(
    (a, b) => new Date(a.batch.sowedAt || 0) - new Date(b.batch.sowedAt || 0)
  );
}

/**
 * What releasing an order's own sowing / excess cover would add back, per batch,
 * so the delivery-change picker can offer those plants before the release is saved.
 */
async function orderReleaseAdjustments(orderId) {
  const byBatch = new Map();
  const sowedBySlot = new Map();
  const order = await Order.findById(toOid(orderId))
    .select(
      "numberOfPlants additionalPlants sowingDone sowingDoneRequestId sowingCoverSources sowingCoverReversedAt"
    )
    .lean();
  if (!order) return { byBatch, sowedBySlot };
  const orderKey = String(order._id);
  if (hasActiveExcessCover(order)) {
    for (const s of order.sowingCoverSources) {
      const key = String(s.batchId);
      const plants = int(s.plants);
      const adj = byBatch.get(key) || { coveredDec: 0, sowedInc: 0, orderKey };
      if (s.moved) {
        adj.sowedInc += plants;
        const slotKey = String(s.slotId);
        sowedBySlot.set(slotKey, (sowedBySlot.get(slotKey) || 0) + plants);
      } else {
        adj.coveredDec += plants;
      }
      byBatch.set(key, adj);
    }
  } else if (order.sowingDone) {
    let left = orderPlantsNeed(order);
    for (const r of await findOwnSowBatches(order)) {
      if (left <= 0) break;
      const rel = Math.min(left, int(r.batch.orderCoveredPlants));
      if (rel <= 0) continue;
      byBatch.set(String(r.batch._id), { coveredDec: rel, sowedInc: 0, orderKey });
      left -= rel;
    }
  }
  return { byBatch, sowedBySlot };
}

function applyReleaseToBatch(batch, release) {
  const adj = release?.byBatch.get(String(batch._id));
  if (!adj) return batch;
  return {
    ...batch,
    plantsSowed: int(batch.plantsSowed) + adj.sowedInc,
    orderCoveredPlants: Math.max(0, int(batch.orderCoveredPlants) - adj.coveredDec),
    excessAllocations: (batch.excessAllocations || []).filter(
      (a) => String(a?.orderId) !== adj.orderKey
    ),
  };
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
  releaseOrderId = null,
  maxWindowDays = null,
}) {
  const plantOid = toOid(plantId);
  const subtypeOid = toOid(subtypeId);
  const deliveryIst = deliveryDateToIstMoment(deliveryDate);
  const needQty = int(need);
  const plantCap = plantOid
    ? await excessWindowCapForPlant(plantOid)
    : DEFAULT_EXCESS_MAX_WINDOW_DAYS;
  let requested = Math.max(0, Math.floor(Number(windowDays) || 0));
  // Papaya always searches ±40 unless the caller asked for a wider scan.
  if (plantCap > DEFAULT_EXCESS_MAX_WINDOW_DAYS && maxWindowDays == null) {
    requested = Math.max(requested, plantCap);
  }
  const cap =
    maxWindowDays == null
      ? plantCap
      : Math.max(plantCap, Math.floor(Number(maxWindowDays) || 0));
  const win = Math.min(cap, requested);
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
              destroyedPlants: { $ifNull: ["$$b.destroyedPlants", 0] },
              excessAllocations: { $ifNull: ["$$b.excessAllocations", []] },
              excessPlants: { $ifNull: ["$$b.excessPlants", 0] },
              actualPlantsApplied: "$$b.actualPlantsApplied",
              expectedMortalityApplied: "$$b.expectedMortalityApplied",
              availablePlantsApplied: "$$b.availablePlantsApplied",
              noMortalityReserve: "$$b.noMortalityReserve",
              isIrrelevant: { $ifNull: ["$$b.isIrrelevant", false] },
              shedName: "$$b.shedName",
              requestNumber: "$$b.requestNumber",
              sowingRequestId: "$$b.sowingRequestId",
            },
          },
        },
      },
    },
  ]);

  const release = releaseOrderId ? await orderReleaseAdjustments(releaseOrderId) : null;
  const entries = [];
  for (const slot of rows) {
    const batches = (slot.batches || []).map((b) => applyReleaseToBatch(b, release));
    const primarySowed =
      int(slot.primarySowed) + (release?.sowedBySlot.get(String(slot.slotId)) || 0);
    const excessForBooking = slotSowStock({ primarySowed, sowingBatches: batches }).free;
    let slotCap = excessForBooking;
    if (slotCap <= 0) continue;

    const ordered = [...batches].sort(
      (a, b) => new Date(a.sowedAt || 0) - new Date(b.sowedAt || 0)
    );
    for (const b of ordered) {
      if (slotCap <= 0) break;
      const sowed = int(b.plantsSowed);
      if (sowed <= 0) continue;
      const rawFree = sowBatchStock(b).free;
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

/** How far from the requested delivery date other days are suggested. */
export const SUGGEST_RANGE_DAYS = 45;

/**
 * Other delivery days (today or later, within ±SUGGEST_RANGE_DAYS) whose excess within
 * ±coverWindowDays can cover the whole order. Nearest to the requested date first.
 */
export async function suggestExcessDays({
  plantId,
  subtypeId,
  deliveryDate,
  need,
  releaseOrderId = null,
  coverWindowDays = EXCESS_COVER_WINDOW_DAYS,
  limit = 6,
}) {
  const needQty = int(need);
  const deliveryIst = deliveryDateToIstMoment(deliveryDate);
  if (!needQty || !deliveryIst) return [];
  const span = SUGGEST_RANGE_DAYS + coverWindowDays;
  const wide = await listExcessBatches({
    plantId,
    subtypeId,
    deliveryDate,
    need: needQty,
    windowDays: span,
    maxWindowDays: span,
    releaseOrderId,
  });
  const entries = wide.entries.map((e) => ({
    free: e.freePlants,
    ready: slotDayStartMoment(e.plantReadyDate) || deliveryIst.clone().add(e.offsetDays, "days"),
  }));
  if (!entries.length) return [];

  const today = deliveryDateToIstMoment(new Date());
  const out = [];
  for (let off = -SUGGEST_RANGE_DAYS; off <= SUGGEST_RANGE_DAYS; off += 1) {
    if (off === 0) continue;
    const day = deliveryIst.clone().add(off, "days");
    if (today && day.isBefore(today, "day")) continue;
    let freePlants = 0;
    const used = [];
    entries.forEach((e, i) => {
      if (Math.abs(e.ready.diff(day, "days")) <= coverWindowDays) {
        freePlants += e.free;
        used.push(i);
      }
    });
    if (freePlants >= needQty) {
      out.push({
        date: day.format("YYYY-MM-DD"),
        offsetDays: off,
        freePlants,
        entryCount: used.length,
        key: used.join(","),
      });
    }
  }
  out.sort((a, b) => Math.abs(a.offsetDays) - Math.abs(b.offsetDays) || a.offsetDays - b.offsetDays);
  const seen = new Set();
  const distinct = [];
  for (const d of out) {
    if (seen.has(d.key)) continue;
    seen.add(d.key);
    const { key: _key, ...rest } = d;
    distinct.push(rest);
    if (distinct.length >= limit) break;
  }
  return distinct;
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
 * Cover an order from a source batch: plants stay on that sowing.
 * Excess / saleable goes down; orderCoveredPlants and reserved go up.
 * No second sowing entry is created, even if the booking slot is different.
 */
async function applySourcePick({
  pick,
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
  const excessDec = Math.min(take, Math.max(0, excessiveLeft));
  const availDec = Math.min(take, Math.max(0, availableLeft));
  const batchExcessDec = Math.min(take, int(pick.batchExcessPlants));
  const maxCoveredBefore = pick.plantsSowed - take;
  const batchAvailableDec =
    pick.batchAvailableApplied != null ? Math.min(availDec, int(pick.batchAvailableApplied)) : availDec;

  const batchMatch = {
    _id: batchOid,
    $or: [
      { orderCoveredPlants: { $lte: maxCoveredBefore } },
      { orderCoveredPlants: { $exists: false } },
      { orderCoveredPlants: null },
    ],
  };
  const slotMatch = { _id: slotOid, sowingBatches: { $elemMatch: batchMatch } };
  if (excessDec > 0) slotMatch["excessiveSowing.plants"] = { $gte: excessDec };
  if (availDec > 0) slotMatch.availablePlants = { $gte: availDec };

  const inc = {
    [`${BATCH_PATH}.orderCoveredPlants`]: take,
    [`${SLOT_PATH}.orderReservedPlants`]: take,
    [`${BATCH_PATH}.orderReservedPlantsApplied`]: take,
  };
  if (availDec > 0) inc[`${SLOT_PATH}.availablePlants`] = -availDec;
  if (excessDec > 0) inc[`${SLOT_PATH}.excessiveSowing.plants`] = -excessDec;
  if (batchExcessDec > 0) inc[`${BATCH_PATH}.excessPlants`] = -batchExcessDec;
  if (batchAvailableDec > 0) inc[`${BATCH_PATH}.availablePlantsApplied`] = -batchAvailableDec;

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

  return {
    moved: false,
    reservedOnSource: true,
    excessDec,
    availDec,
    batchExcessDec,
    actualDec: 0,
    mortalityDec: 0,
    batchActualDec: 0,
    batchMortalityDec: 0,
    batchAvailableDec,
    destSlotId: null,
    destBatchId: null,
  };
}

/** Undo one source pick (and remove the moved sow entry from the booking slot). */
async function revertSourcePick({
  batchId,
  plants,
  moved = false,
  reservedOnSource = false,
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
  if (reservedOnSource) {
    inc[`${SLOT_PATH}.orderReservedPlants`] = -plants;
    inc[`${BATCH_PATH}.orderReservedPlantsApplied`] = -plants;
    if (batchAvailableDec > 0) inc[`${BATCH_PATH}.availablePlantsApplied`] = batchAvailableDec;
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
 * Cover a booked order from picked sowing batches: order cover stays on that
 * sowing (no new sowing entry). Order sowingDone + sowingCoverSources + trails.
 */
export async function coverOrderFromBatches({
  order: orderInput,
  picks,
  userId,
  quiet = false,
  windowDays = EXCESS_COVER_WINDOW_DAYS,
}) {
  const orderOid = toOid(orderInput?._id || orderInput);
  if (!orderOid) throw new ExcessCoverError("ORDER_NOT_FOUND", "Order not found", 404);
  const order = await Order.findById(orderOid)
    .select(
      "orderId plantName plantSubtype deliveryDate bookingSlot numberOfPlants additionalPlants sowingPartialCover sowingDone orderStatus productMappingId"
    )
    .lean();
  if (!order) throw new ExcessCoverError("ORDER_NOT_FOUND", "Order not found", 404);
  if (order.sowingDone) {
    throw new ExcessCoverError("ALREADY_SOWED", "Order is already marked sow completed", 409);
  }

  const held = (Array.isArray(order.sowingPartialCover) ? order.sowingPartialCover : []).reduce(
    (sum, row) => sum + (Number(row?.plants) || 0),
    0
  );
  const need = Math.max(0, orderPlantsNeed(order) - held);
  if (need <= 0) {
    throw new ExcessCoverError("NOTHING_TO_COVER", "This order has no plants left to cover");
  }
  const { picks: matched } = await validateCoverPicks({
    plantId: order.plantName,
    subtypeId: order.plantSubtype,
    deliveryDate: order.deliveryDate,
    need,
    picks,
    windowDays,
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

  const rollback = async () => {
    for (const a of applied.reverse()) {
      try {
        await revertSourcePick({ ...a, orderOid });
      } catch (err) {
        console.error("[excessCover] rollback source failed:", err?.message || err);
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
      orderOid,
      userOid,
      now,
      excessiveLeft,
      availableLeft,
    });
    if (!res) {
      await rollback();
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
    reservedOnSource: true,
    moved: false,
    destSlotId: null,
    destBatchId: null,
    actualPlantsDec: 0,
    expectedMortalityDec: 0,
    batchActualAppliedDec: 0,
    batchMortalityAppliedDec: 0,
    batchAvailableAppliedDec: applied[i].batchAvailableDec,
  }));
  const remark = coverRemark(sources);
  const sourceReqId = toOid(matched[0]?.sowingRequestId);

  const marked = await Order.findOneAndUpdate(
    { _id: orderOid, sowingDone: { $ne: true } },
    {
      $set: {
        sowingDone: true,
        sowingDoneAt: now,
        sowingCoverSources: sources,
        ...(sourceReqId ? { sowingDoneRequestId: sourceReqId } : {}),
      },
      $unset: { sowingCoverReversedAt: "" },
      ...(quiet ? {} : { $push: { orderRemarks: remark } }),
    },
    { new: true }
  );
  if (!marked) {
    await rollback();
    throw new ExcessCoverError("ALREADY_SOWED", "Order is already marked sow completed", 409);
  }

  const sourceReqIds = [
    ...new Set(matched.map((p) => String(p.sowingRequestId || "")).filter((id) => mongoose.Types.ObjectId.isValid(id))),
  ].map((id) => toOid(id));
  if (sourceReqIds.length) {
    await SowingRequest.updateMany(
      { _id: { $in: sourceReqIds } },
      { $addToSet: { linkedOrderIds: orderOid } }
    );
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
    sowingDoneRequestId: sourceReqId || null,
    requestNumber: matched[0]?.requestNumber || null,
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
      reservedOnSource: Boolean(s.reservedOnSource),
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
  const reservedOnSource = sources.some((s) => s.reservedOnSource);
  if (!reservedOnSource) {
    await incDestinationReserved(destSlotId, -(coveredTotal || need), session);
  }
  await removeCoverPointerBatches(auditRequestId, session);
  const unlinkReqIds = [
    ...new Set(
      [auditRequestId, ...sources.map((s) => s.sowingRequestId)]
        .map((id) => toOid(id))
        .filter(Boolean)
        .map(String)
    ),
  ].map((id) => toOid(id));
  if (unlinkReqIds.length) {
    await SowingRequest.collection.updateMany(
      { _id: { $in: unlinkReqIds } },
      { $pull: { linkedOrderIds: orderOid } },
      session ? { session } : undefined
    );
  }

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

/** IST start of a slot's first day (fallback delivery date when only bookingSlot changes). */
export async function slotStartDateById(slotId, session) {
  const slotOid = toOid(slotId);
  if (!slotOid) return null;
  const agg = PlantSlot.aggregate([
    { $match: { "subtypeSlots.slots._id": slotOid } },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $match: { "subtypeSlots.slots._id": slotOid } },
    { $project: { _id: 0, startDay: "$subtypeSlots.slots.startDay" } },
  ]);
  if (session) agg.session(session);
  const [row] = await agg;
  return slotDayStartMoment(row?.startDay)?.toDate() || null;
}

/** A sowed order may move this many days before / after its own sowing's ready date. */
export const OWN_SOW_EARLY_DAYS = 3;
export const OWN_SOW_LATE_DAYS = 5;

async function ownSowReadyDates(order, session) {
  if (hasActiveExcessCover(order)) {
    return [...new Set(order.sowingCoverSources.map((s) => s.plantReadyDate).filter(Boolean))];
  }
  if (!order?.sowingDone) return [];
  const rows = await findOwnSowBatches(order, session);
  const dates = rows.map((r) => r.batch.plantReadyDate || r.startDay).filter(Boolean);
  if (dates.length) return [...new Set(dates)];
  const old = deliveryDateToIstMoment(order.deliveryDate);
  return old ? [old.format("DD-MM-YYYY")] : [];
}

/**
 * Can a sowed order keep its own sowing (or excess cover) at a new delivery date?
 * Within when every ready date is OWN_SOW_EARLY_DAYS before .. OWN_SOW_LATE_DAYS after it.
 */
export async function ownSowTolerance(order, newDeliveryDate, session) {
  const sowed = Boolean(order?.sowingDone) || hasActiveExcessCover(order);
  const base = {
    sowed,
    readyDate: null,
    offsetDays: null,
    withinTolerance: false,
    earlyDays: OWN_SOW_EARLY_DAYS,
    lateDays: OWN_SOW_LATE_DAYS,
  };
  if (!sowed) return base;
  const target = deliveryDateToIstMoment(newDeliveryDate);
  if (!target) return base;
  let worst = null;
  let within = true;
  for (const d of await ownSowReadyDates(order, session)) {
    const ready = slotDayStartMoment(d);
    if (!ready) continue;
    const off = target.diff(ready, "days");
    if (off < -OWN_SOW_EARLY_DAYS || off > OWN_SOW_LATE_DAYS) within = false;
    if (!worst || Math.abs(off) > Math.abs(worst.off)) worst = { off, d };
  }
  if (!worst) return base;
  return { ...base, readyDate: worst.d, offsetDays: worst.off, withinTolerance: within };
}

/**
 * Delivery change beyond tolerance: return a normally sowed order's plants to its
 * sowing batches as excess (slot reserve → available) and mark the order not sowed.
 */
export async function releaseOrderOwnSow({ order, userId, session, quiet = false }) {
  if (!order?.sowingDone || !order?.sowingDoneRequestId || hasActiveExcessCover(order)) {
    return { released: false, plants: 0 };
  }
  const orderOid = toOid(order._id);
  const reqOid = toOid(order.sowingDoneRequestId);
  const opts = session ? { session } : {};
  let left = orderPlantsNeed(order);
  let total = 0;
  const bySlot = new Map();

  for (const r of await findOwnSowBatches(order, session)) {
    if (left <= 0) break;
    const release = Math.min(left, int(r.batch.orderCoveredPlants));
    if (release <= 0) continue;
    const relRes = Math.min(release, int(r.batch.orderReservedPlantsApplied), int(r.orderReservedPlants));
    const batchOid = toOid(r.batch._id);
    const inc = {
      [`${BATCH_PATH}.orderCoveredPlants`]: -release,
      [`${BATCH_PATH}.excessPlants`]: release,
    };
    if (relRes > 0) {
      inc[`${BATCH_PATH}.orderReservedPlantsApplied`] = -relRes;
      inc[`${BATCH_PATH}.availablePlantsApplied`] = relRes;
      inc[`${SLOT_PATH}.orderReservedPlants`] = -relRes;
      inc[`${SLOT_PATH}.availablePlants`] = relRes;
      inc[`${SLOT_PATH}.excessiveSowing.plants`] = relRes;
    }
    const res = await PlantSlot.collection.updateOne(
      batchExistsFilter(batchOid, { orderCoveredPlants: { $gte: release } }),
      { $inc: inc, $pull: { [`${BATCH_PATH}.linkedOrderIds`]: orderOid } },
      { arrayFilters: batchFilters(batchOid), ...opts }
    );
    if (!res.matchedCount) continue;
    left -= release;
    total += release;
    const key = String(r.slotId);
    const prev = bySlot.get(key) || { plants: 0, label: slotLabel(r) };
    prev.plants += release;
    bySlot.set(key, prev);
  }

  const labels = [...bySlot.values()].map((s) => s.label).join(", ");
  await Order.collection.updateOne(
    { _id: orderOid },
    {
      $set: { sowingDone: false },
      $unset: { sowingDoneAt: "", sowingDoneRequestId: "" },
      ...(quiet
        ? {}
        : {
            $push: {
              orderRemarks: `Own sowing released on delivery change: ${total.toLocaleString("en-IN")} plants returned as excess to ${labels || "sowing entry"}`,
            },
          }),
    },
    opts
  );
  if (reqOid) {
    await SowingRequest.collection.updateOne(
      { _id: reqOid },
      { $pull: { linkedOrderIds: orderOid } },
      opts
    );
  }

  if (!quiet) {
    const at = new Date();
    for (const [slotId, s] of bySlot) {
      try {
        await recordSlotTrail(
          slotId,
          {
            at,
            timestamp: at,
            action: SLOT_TRAIL_ACTIONS.ORDER_OWN_SOW_RELEASED,
            activityName: getSlotTrailActivityName(SLOT_TRAIL_ACTIONS.ORDER_OWN_SOW_RELEASED),
            quantity: s.plants,
            plants: s.plants,
            orderId: order.orderId,
            orderRef: orderOid,
            performedBy: userId || null,
            reason: `Order #${order.orderId} delivery changed — ${s.plants} sowed plants returned as excess`,
          },
          session
        );
      } catch (err) {
        console.error("[excessCover] own-sow release trail failed:", err?.message || err);
      }
    }
  }

  return { released: true, plants: total, slots: bySlot.size };
}
