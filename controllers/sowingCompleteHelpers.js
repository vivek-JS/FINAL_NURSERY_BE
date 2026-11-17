import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import InventoryOutward from "../models/inventoryOutward.model.js";
import ReturnRequest from "../models/returnRequest.model.js";
import PlantCms from "../models/plantCms.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import SowingEntry from "../models/sowingEntry.model.js";
import {
  fmtDDMMYYYY,
  addDays,
  resolveCmsReadyDays,
  findSlotByPlantReadyDate,
  resolveReadyDays,
  parseLocalDate,
} from "./sowingSlotReadyHelpers.js";
import {
  sowQtySlotImpact,
  splitLagwadQtyForSlot,
  clampMortalityPct,
  sowCoverPool,
} from "../utility/lagwadSlotPlantsSplit.js";
import { plantMortalityPct } from "../utility/plantSowingBuffer.js";
import {
  removeSowingEntryForBatch,
  upsertSowingEntryForRequest,
  upsertSowingEntryFromBatch,
} from "../modules/sowingEntries/saveSowingEntry.js";

/** After cover is written on the slot batch, copy it onto the sowing entry. */
async function refreshSowingEntriesOnSlot(slotId, sowingRequestId) {
  try {
    const rows = await PlantSlot.aggregate([
      { $match: { "subtypeSlots.slots._id": slotId } },
      { $unwind: "$subtypeSlots" },
      { $unwind: "$subtypeSlots.slots" },
      { $match: { "subtypeSlots.slots._id": slotId } },
      { $unwind: "$subtypeSlots.slots.sowingBatches" },
      { $match: { "subtypeSlots.slots.sowingBatches.sowingRequestId": sowingRequestId } },
      { $project: { batch: "$subtypeSlots.slots.sowingBatches" } },
    ]);
    for (const row of rows) {
      if (row?.batch) await upsertSowingEntryFromBatch(row.batch, slotId);
    }
  } catch (err) {
    console.error("[sowing] entry cover refresh failed:", err?.message || err);
  }
}

async function mortalityPctForPlant(plantId) {
  if (!plantId) return 10;
  const p = await PlantCms.findById(plantId).select("sowingMortality sowingBuffer").lean();
  const fromCms = plantMortalityPct(p);
  if (fromCms > 0) return fromCms;
  return clampMortalityPct(p?.sowingMortality, 10);
}
import { updatePlantSlotCapped } from "../utility/shrinkPlantSlotTrails.js";
import {
  planOrderSowCover,
  fillLastPartialFromBuffer,
  applyIncompleteRequestRelease,
  orderPlantTotal,
  orderCoveredExceptRequest,
} from "../services/orderSowCover.plan.js";
import { moveLinkedOrdersBookingSlotOnSowEdit } from "../utility/readySlotOrderCover.js";

function hasAppliedSplit(batch) {
  return (
    batch != null &&
    (batch.actualPlantsApplied != null || batch.expectedMortalityApplied != null)
  );
}

function reverseActualFromBatch(batch, qty) {
  if (hasAppliedSplit(batch)) {
    return Math.max(0, Number(batch.actualPlantsApplied) || 0);
  }
  return Math.max(0, Number(qty) || 0);
}

function reverseMortFromBatch(batch) {
  return Math.max(0, Number(batch?.expectedMortalityApplied) || 0);
}

function reverseAvailableFromBatch(batch, qty) {
  if (hasAppliedSplit(batch)) {
    return Math.max(0, Number(batch.availablePlantsApplied) || 0);
  }
  const excess = Math.max(0, Number(batch?.excessPlants) || 0);
  if (batch?.isExcessiveSowing) return Math.max(0, Number(qty) || 0);
  return excess;
}

function reverseReservedFromBatch(batch) {
  if (hasAppliedSplit(batch)) {
    return Math.max(0, Number(batch.orderReservedPlantsApplied) || 0);
  }
  return Math.max(0, Number(batch?.orderCoveredPlants) || 0);
}

export function parseNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Cover orders with deliveryDate within readyDate ± N days (FIFO full-cover). */
export const ORDER_COVER_WINDOW_DAYS = 5;

export function deliveryCoverWindow(readyDate, windowDays = ORDER_COVER_WINDOW_DAYS) {
  const win = Math.max(0, Math.floor(Number(windowDays) || 0));
  const dayStart = new Date(readyDate);
  dayStart.setHours(0, 0, 0, 0);
  dayStart.setDate(dayStart.getDate() - win);
  const dayEnd = new Date(readyDate);
  dayEnd.setHours(23, 59, 59, 999);
  dayEnd.setDate(dayEnd.getDate() + win);
  return { dayStart, dayEnd, windowDays: win };
}

const COMPLETION_EVENT_TYPES = new Set([
  "SOW_STARTED",
  "PLANTS_SOWED",
  "PACKETS_USED",
  "PACKETS_RETURNED",
  "PACKETS_ISSUED",
  "INVENTORY_RESTORED",
  "ORDERS_MARKED_SOWED",
  "ORDERS_COVERED",
  "ORDER_COVER_APPLIED",
  "ORDER_COVER_REVERSED",
  "ORDER_LINKED",
  "COVER_FROM_EXCESS",
  "LABOUR_RECORDED",
  "SOW_COMPLETED",
  "SOW_ENTRY_EDITED",
  "READY_PLANTS_RECEIVED",
  "MORTALITY_TO_EXCESS",
  "BATCH_DESTROYED",
  "BATCH_IRRELEVANT",
  "SLOT_MOVED",
  "PHOTO_ADDED",
  "NOTE",
]);

export function pushEvent(request, evt) {
  if (!Array.isArray(request.completionEvents)) request.completionEvents = [];
  const type = COMPLETION_EVENT_TYPES.has(String(evt?.type || ""))
    ? evt.type
    : "NOTE";
  request.completionEvents.push({
    at: new Date(),
    ...evt,
    type,
    ...(type === "NOTE" && evt?.type && evt.type !== "NOTE"
      ? { meta: { ...(evt.meta || {}), originalType: evt.type } }
      : {}),
  });
}

function toObjectIds(ids) {
  return (ids || [])
    .map((id) => {
      try {
        return new mongoose.Types.ObjectId(id);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function quickReturnRequestNumber(seq = 0) {
  const d = new Date();
  const ymd =
    String(d.getFullYear()).slice(-2) +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");
  const tail = `${Date.now().toString(36)}${seq.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 4)}`.toUpperCase();
  return `RR${ymd}${tail}`;
}

/**
 * After order FIFO cover on ready slot:
 * - excess → saleable availablePlants + excessiveSowing
 * - covered → orderReservedPlants (not for open sale)
 * Skips full isExcessiveSowing batches (already counted at apply time).
 */
export async function recordExcessPlantsOnSlot(
  slotId,
  sowingRequestId,
  excessPlants,
  orderCoveredPlants = 0,
  coveredOrderIds = []
) {
  const qty = Math.max(0, Math.floor(Number(excessPlants) || 0));
  const covered = Math.max(0, Math.floor(Number(orderCoveredPlants) || 0));
  if (!slotId || !sowingRequestId) {
    return { excessPlants: 0, orderCoveredPlants: 0 };
  }
  const sid = new mongoose.Types.ObjectId(slotId);
  const rid = new mongoose.Types.ObjectId(sowingRequestId);
  const orderIds = toObjectIds(coveredOrderIds);
  const reqRow = await SowingRequest.findById(rid).select("plantId").lean();
  const mortalityPct = await mortalityPctForPlant(reqRow?.plantId);

  const impact = sowQtySlotImpact(qty + covered, {
    excessPlants: qty,
    orderCoveredPlants: covered,
    mortalityPct,
  });
  const availInc = impact.availablePlants;
  const reservedInc = impact.orderReservedPlants;
  // Apply step already moved plant mortality %; the order buffer can raise it.
  const mortalityExtra = Math.max(
    0,
    impact.expectedMortality -
      splitLagwadQtyForSlot(impact.plantsSowed, mortalityPct).expectedMortality
  );

  const update = {
    $set: {
      ...(mortalityExtra > 0
        ? {
            "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].actualPlantsApplied":
              impact.actualPlants,
            "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].expectedMortalityApplied":
              impact.expectedMortality,
          }
        : {}),
      "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].orderCoveredPlants":
        covered,
      "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].excessPlants": qty,
      "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].availablePlantsApplied":
        availInc,
      "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].orderReservedPlantsApplied":
        reservedInc,
      ...(orderIds.length
        ? {
            "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].linkedOrderIds":
              orderIds,
          }
        : {}),
    },
  };
  const inc = {};
  if (availInc > 0) {
    inc["subtypeSlots.$[st].slots.$[sl].excessiveSowing.plants"] = availInc;
    inc["subtypeSlots.$[st].slots.$[sl].availablePlants"] = availInc;
  }
  if (reservedInc > 0) {
    inc["subtypeSlots.$[st].slots.$[sl].orderReservedPlants"] = reservedInc;
  }
  if (mortalityExtra > 0) {
    inc["subtypeSlots.$[st].slots.$[sl].expectedMortality"] = mortalityExtra;
    inc["subtypeSlots.$[st].slots.$[sl].actualPlants"] = -mortalityExtra;
  }
  if (Object.keys(inc).length) update.$inc = inc;

  await updatePlantSlotCapped(
    {
      "subtypeSlots.slots._id": sid,
      "subtypeSlots.slots.sowingBatches.sowingRequestId": rid,
    },
    update,
    {
      arrayFilters: [
        { "st.slots._id": sid },
        { "sl._id": sid },
        { "b.sowingRequestId": rid },
      ],
    }
  );
  await refreshSowingEntriesOnSlot(sid, rid);
  return { excessPlants: qty, orderCoveredPlants: covered };
}

async function pushBatchToSlot(slotId, { inc, sowingDateStr, plantReadyDateStr, readyDays, batch }) {
  if (!batch._id) batch._id = new mongoose.Types.ObjectId();
  const isExcess = Boolean(batch.isExcessiveSowing);
  const appliedAvail = batch.availablePlantsApplied;
  const saleable =
    appliedAvail != null && Number.isFinite(Number(appliedAvail))
      ? Math.max(0, Number(appliedAvail) || 0)
      : isExcess
        ? sowQtySlotImpact(Number(batch.plantsSowed) || 0, { isExcess: true })
            .availablePlants
        : sowQtySlotImpact(0, {
            excessPlants: Number(batch.excessPlants) || 0,
          }).availablePlants;
  const incDoc = { ...inc };
  if (saleable > 0) {
    incDoc["subtypeSlots.$[st].slots.$[sl].excessiveSowing.plants"] = saleable;
  }
  await updatePlantSlotCapped(
    { "subtypeSlots.slots._id": slotId },
    {
      $inc: incDoc,
      $set: {
        "subtypeSlots.$[st].slots.$[sl].sowingDate": sowingDateStr,
        "subtypeSlots.$[st].slots.$[sl].plantReadyDate": plantReadyDateStr,
        ...(readyDays > 0
          ? { "subtypeSlots.$[st].slots.$[sl].plantReadyDays": readyDays }
          : {}),
      },
      $push: {
        "subtypeSlots.$[st].slots.$[sl].sowingBatches": {
          $each: [batch],
          $position: 0,
          $slice: 40,
        },
      },
      $addToSet: {
        "subtypeSlots.$[st].slots.$[sl].linkedSowingRequests": batch.sowingRequestId,
      },
      $pull: {
        "subtypeSlots.$[st].slots.$[sl].sowingInProgress": {
          sowingRequestId: batch.sowingRequestId,
        },
      },
    },
    {
      arrayFilters: [{ "st.slots._id": slotId }, { "sl._id": slotId }],
    }
  );
  await upsertSowingEntryFromBatch(batch, slotId);
  return { batchId: batch._id, slotId };
}

function coverSourceDoc({ requestId, requestNumber, plants, sowingDate, plantReadyDate, batchId, slotId }) {
  const doc = {
    sowingRequestId: requestId,
    requestNumber,
    plants,
    sowingDate,
    plantReadyDate,
  };
  if (batchId && mongoose.Types.ObjectId.isValid(String(batchId))) {
    doc.batchId = new mongoose.Types.ObjectId(String(batchId));
  }
  if (slotId && mongoose.Types.ObjectId.isValid(String(slotId))) {
    doc.slotId = new mongoose.Types.ObjectId(String(slotId));
  }
  return doc;
}

async function resolveCoverBatch(request, opts = {}) {
  if (opts.batchId && mongoose.Types.ObjectId.isValid(String(opts.batchId))) {
    return { batchId: opts.batchId, slotId: opts.slotId || null };
  }
  const entry = await SowingEntry.findOne({ sowingRequestId: request?._id })
    .select("sourceBatchId")
    .lean();
  if (entry?.sourceBatchId) return { batchId: entry.sourceBatchId, slotId: opts.slotId || null };
  return { batchId: null, slotId: opts.slotId || null };
}

/** Write the sowing batch onto cover rows that were saved with only the request. */
export async function stampCoverBatchIds(requestId, batchId, slotId) {
  if (!requestId || !batchId || !mongoose.Types.ObjectId.isValid(String(batchId))) {
    return { matched: 0, modified: 0 };
  }
  const set = {
    "sowingCoverSources.$[src].batchId": new mongoose.Types.ObjectId(String(batchId)),
  };
  if (slotId && mongoose.Types.ObjectId.isValid(String(slotId))) {
    set["sowingCoverSources.$[src].slotId"] = new mongoose.Types.ObjectId(String(slotId));
  }
  const res = await Order.updateMany(
    { "sowingCoverSources.sowingRequestId": requestId },
    { $set: set },
    { arrayFilters: [{ "src.sowingRequestId": requestId, "src.batchId": null }] }
  );
  return { matched: res.matchedCount || 0, modified: res.modifiedCount || 0 };
}

/**
 * Write this sow on sowingentries only.
 * plantReadyDate = sowDate + plantReadyDays. Calendar slots are left as they are.
 */
export async function applyPlantsToLinkedSlots(request, plantsSowed, meta = {}) {
  if (plantsSowed <= 0) return { slotsUpdated: 0 };

  const requestNumber = meta.requestNumber || request.requestNumber || "";
  const shedName = String(meta.shedName || request.shedName || "").trim();
  const linkedOrderIds = toObjectIds(
    meta.linkedOrderIds || request.linkedOrderIds || []
  );
  const isExcess = Boolean(
    meta.isExcessiveSowing ?? request.isExcessiveSowing
  );

  const sowedAt =
    meta.sowedAt instanceof Date && !Number.isNaN(meta.sowedAt.getTime())
      ? meta.sowedAt
      : new Date();
  const sowingDateStr = fmtDDMMYYYY(sowedAt);

  const plantId = request.plantId || meta.plantId;
  const subtypeId = request.subtypeId || meta.subtypeId;
  const overrideMort = Number(meta.mortalityPct);
  const mortalityPct =
    Number.isFinite(overrideMort) && overrideMort >= 0
      ? clampMortalityPct(overrideMort, 10)
      : await mortalityPctForPlant(plantId);
  const cmsReadyDays = await resolveCmsReadyDays(plantId, subtypeId);
  const overrideReady = Number(meta.plantReadyDays);
  // Explicit 0 = already-ready plants (same-day ready / excess on that date).
  const readyDaysGlobal =
    Number.isFinite(overrideReady) && overrideReady >= 0
      ? overrideReady
      : cmsReadyDays;
  const plantReadyDateStr = fmtDDMMYYYY(addDays(sowedAt, readyDaysGlobal || 0));
  const outParsed = meta.out || meta.outDate ? parseLocalDate(meta.out || meta.outDate) : null;
  const requestedOut = outParsed ? fmtDDMMYYYY(outParsed) : "";

  const readyDays = readyDaysGlobal || 0;
  const impact = sowQtySlotImpact(plantsSowed, { isExcess, mortalityPct });
  const entry = await upsertSowingEntryForRequest(request, {
    sowingDate: sowingDateStr,
    plantReadyDate: plantReadyDateStr,
    out: requestedOut || plantReadyDateStr,
    plantsSowed,
    shedName,
    sowingRequestId: request._id,
    requestNumber,
    isExcessiveSowing: isExcess,
    entryKind:
      meta.entryKind === "komb" || meta.entryKind === "excess" ? meta.entryKind : "sowing",
    sourceEntryId: meta.sourceEntryId || null,
    orderCoveredPlants: isExcess
      ? 0
      : Math.min(
          sowCoverPool(plantsSowed, mortalityPct),
          Math.max(0, plantsSowed - Math.max(0, Number(meta.excessPlants) || 0))
        ),
    excessPlants: isExcess ? plantsSowed : Math.max(0, Number(meta.excessPlants) || 0),
    ...(Number.isFinite(overrideMort) && overrideMort === 0
      ? {
          noMortalityReserve: true,
          sowingBufferPct: 0,
          bufferPlants: 0,
        }
      : Number.isFinite(overrideMort) && overrideMort > 0
        ? { sowingBufferPct: clampMortalityPct(overrideMort, 10) }
        : {}),
    linkedOrderIds,
  });

  return {
    slotsUpdated: 0,
    sowingDate: sowingDateStr,
    plantReadyDays: readyDays,
    plantReadyDate: plantReadyDateStr,
    appliedSlotId: null,
    resolvedByReadyDate: false,
    actualPlants: impact.actualPlants,
    expectedMortality: impact.expectedMortality,
    batchId: entry?.sourceBatchId || null,
  };
}

/** Decrement plants / remove batch for a sowingRequest on a slot. */
export async function reverseSowBatchFromSlot(slotId, sowingRequestId, plantsSowed) {
  const qty = Math.max(0, Number(plantsSowed) || 0);
  if (!slotId || !sowingRequestId || qty <= 0) return { reversed: 0 };

  const id = new mongoose.Types.ObjectId(slotId);
  const reqId = new mongoose.Types.ObjectId(sowingRequestId);

  // Read batch split so we reverse reserved vs saleable correctly
  const batchRows = await findSowBatchForRequest(sowingRequestId);
  const found = (batchRows || []).find(
    (r) => String(r.slotId) === String(slotId)
  );
  const batch = found?.batch || null;
  const actualRev = reverseActualFromBatch(batch, qty);
  const mortRev = reverseMortFromBatch(batch);
  const saleableRev = reverseAvailableFromBatch(batch, qty);
  const reservedRev = reverseReservedFromBatch(batch);

  const inc = {
    "subtypeSlots.$[st].slots.$[sl].primarySowed": -qty,
    "subtypeSlots.$[st].slots.$[sl].totalPlants": -qty,
    "subtypeSlots.$[st].slots.$[sl].plantsSowed": -qty,
    "subtypeSlots.$[st].slots.$[sl].actualPlants": -actualRev,
  };
  if (mortRev > 0) {
    inc["subtypeSlots.$[st].slots.$[sl].expectedMortality"] = -mortRev;
  }
  if (saleableRev > 0) {
    inc["subtypeSlots.$[st].slots.$[sl].availablePlants"] = -saleableRev;
    inc["subtypeSlots.$[st].slots.$[sl].excessiveSowing.plants"] = -saleableRev;
  }
  if (reservedRev > 0) {
    inc["subtypeSlots.$[st].slots.$[sl].orderReservedPlants"] = -reservedRev;
  }

  await updatePlantSlotCapped(
    { "subtypeSlots.slots._id": id },
    {
      $inc: inc,
      $pull: {
        "subtypeSlots.$[st].slots.$[sl].sowingBatches": {
          sowingRequestId: reqId,
        },
      },
    },
    {
      arrayFilters: [{ "st.slots._id": id }, { "sl._id": id }],
    }
  );
  if (batch?._id) await removeSowingEntryForBatch(batch._id);
  return { reversed: qty };
}

/**
 * Find first sowingBatches entry for a request across plant slots.
 */
export async function findSowBatchForRequest(sowingRequestId) {
  const reqId = new mongoose.Types.ObjectId(sowingRequestId);
  const rows = await PlantSlot.aggregate([
    { $match: { "subtypeSlots.slots.sowingBatches.sowingRequestId": reqId } },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $unwind: "$subtypeSlots.slots.sowingBatches" },
    {
      $match: {
        "subtypeSlots.slots.sowingBatches.sowingRequestId": reqId,
      },
    },
    {
      $project: {
        slotId: "$subtypeSlots.slots._id",
        startDay: "$subtypeSlots.slots.startDay",
        endDay: "$subtypeSlots.slots.endDay",
        plantId: "$plantId",
        subtypeId: "$subtypeSlots.subtypeId",
        batch: "$subtypeSlots.slots.sowingBatches",
      },
    },
    { $limit: 5 },
  ]);
  return rows;
}

/**
 * Edit completed sow entry: update sow date / ready days; reslot by new ready date; append history.
 */
export async function editSowEntryOnSlots(request, opts = {}) {
  const userId = opts.by;
  const batches = await findSowBatchForRequest(request._id);
  if (!batches.length) {
    throw new Error("No sow batch found on slots for this request");
  }

  // Aggregate plants/packets from all batches of this request
  let plantsTotal = 0;
  let packetsTotal = 0;
  let shedName = request.shedName || "";
  let oldHistory = [];
  for (const row of batches) {
    plantsTotal += Number(row.batch?.plantsSowed) || 0;
    packetsTotal += Number(row.batch?.packetsUsed) || 0;
    if (row.batch?.shedName) shedName = row.batch.shedName;
    if (Array.isArray(row.batch?.slotHistory)) {
      oldHistory = oldHistory.concat(row.batch.slotHistory);
    }
  }
  if (opts.plantsSowed != null && Number(opts.plantsSowed) > 0) {
    plantsTotal = Number(opts.plantsSowed);
  }

  const fromSlotId = batches[0].slotId;
  const fromReadyDate = batches[0].batch?.plantReadyDate || "";
  const fromPlantReadyDays = Number(batches[0].batch?.plantReadyDays) || 0;
  const fromSowDate = batches[0].batch?.sowingDate || "";

  const sowedAt =
    parseLocalDate(opts.sowDate) ||
    parseLocalDate(fromSowDate) ||
    (batches[0].batch?.sowedAt
      ? new Date(batches[0].batch.sowedAt)
      : new Date());

  const sowingDateStr = fmtDDMMYYYY(sowedAt);
  const readyOverride =
    parseLocalDate(opts.plantReadyDate) || parseLocalDate(opts.readyDate);
  let toPlantReadyDays;
  let toReadyDate;
  if (readyOverride) {
    toReadyDate = fmtDDMMYYYY(readyOverride);
    toPlantReadyDays = Math.max(
      0,
      Math.round((readyOverride.getTime() - sowedAt.getTime()) / 86400000)
    );
  } else if (
    opts.plantReadyDays != null &&
    Number.isFinite(Number(opts.plantReadyDays)) &&
    Number(opts.plantReadyDays) >= 0
  ) {
    toPlantReadyDays = Number(opts.plantReadyDays);
    toReadyDate = fmtDDMMYYYY(addDays(sowedAt, toPlantReadyDays));
  } else {
    const cmsReady = await resolveCmsReadyDays(request.plantId, request.subtypeId);
    toPlantReadyDays = resolveReadyDays(
      undefined,
      fromPlantReadyDays,
      cmsReady
    );
    if (!(toPlantReadyDays >= 0) || !Number.isFinite(toPlantReadyDays)) {
      throw new Error("plantReadyDays is required");
    }
    toReadyDate = fmtDDMMYYYY(addDays(sowedAt, toPlantReadyDays));
  }

  const target = await findSlotByPlantReadyDate(
    request.plantId,
    request.subtypeId,
    toReadyDate
  );
  if (!target?.slotId) {
    throw new Error(`No calendar slot found for ready date ${toReadyDate}`);
  }

  const toSlotId = target.slotId;
  const slotChanged = String(fromSlotId) !== String(toSlotId);
  const reason =
    opts.reason ||
    (opts.plantReadyDays != null && Number(opts.plantReadyDays) !== fromPlantReadyDays
      ? "EDIT_READY_DAYS"
      : readyOverride
        ? "EDIT_READY_DATE"
        : "EDIT_SOW_DATE");

  // Reverse all old batches for this request
  for (const row of batches) {
    await reverseSowBatchFromSlot(
      row.slotId,
      request._id,
      Number(row.batch?.plantsSowed) || 0
    );
  }

  const histEntry = {
    at: new Date(),
    by: userId || null,
    fromSlotId,
    toSlotId,
    fromReadyDate,
    toReadyDate,
    fromPlantReadyDays,
    toPlantReadyDays,
    sowDate: sowingDateStr,
    plantsSowed: plantsTotal,
    reason,
  };

  const noMort = Boolean(batches[0]?.batch?.noMortalityReserve);
  const prevMortPct = batches[0]?.batch?.mortalityPct;
  const mortalityPct = noMort
    ? 0
    : prevMortPct != null && Number.isFinite(Number(prevMortPct))
      ? clampMortalityPct(Number(prevMortPct), 0)
      : await mortalityPctForPlant(request.plantId);

  // Mortality first, then cover the same orders from the saleable pool.
  let coveredTotal = 0;
  let excessTotal = 0;
  let orderResult = null;
  if (request.isExcessiveSowing) {
    excessTotal = sowCoverPool(plantsTotal, mortalityPct);
  } else {
    const orderIds = await orderIdsCoveredByRequest(request);
    await clearRequestOrderCover(request._id, orderIds);
    orderResult = await markOrdersSowed(request, {
      sowedAt,
      plantsSowed: plantsTotal,
      plantReadyDays: toPlantReadyDays,
      sowingBufferPct: mortalityPct,
      orderIds,
    });
    coveredTotal = Math.max(0, Number(orderResult.orderPlantsCovered) || 0);
    excessTotal = Math.max(0, Number(orderResult.remainingUncovered) || 0);
  }
  const isExcess = Boolean(request.isExcessiveSowing) && coveredTotal <= 0;
  const impact = sowQtySlotImpact(plantsTotal, {
    isExcess,
    excessPlants: excessTotal,
    orderCoveredPlants: coveredTotal,
    mortalityPct,
  });

  const editInc = {
    "subtypeSlots.$[st].slots.$[sl].primarySowed": plantsTotal,
    "subtypeSlots.$[st].slots.$[sl].totalPlants": plantsTotal,
    "subtypeSlots.$[st].slots.$[sl].plantsSowed": plantsTotal,
    "subtypeSlots.$[st].slots.$[sl].actualPlants": impact.actualPlants,
    "subtypeSlots.$[st].slots.$[sl].expectedMortality": impact.expectedMortality,
  };
  if (impact.availablePlants > 0) {
    editInc["subtypeSlots.$[st].slots.$[sl].availablePlants"] =
      impact.availablePlants;
  }
  if (impact.orderReservedPlants > 0) {
    editInc["subtypeSlots.$[st].slots.$[sl].orderReservedPlants"] =
      impact.orderReservedPlants;
  }

  const pushed = await pushBatchToSlot(toSlotId, {
    inc: editInc,
    sowingDateStr,
    plantReadyDateStr: toReadyDate,
    readyDays: toPlantReadyDays,
    batch: {
      sowedAt,
      sowingDate: sowingDateStr,
      plantReadyDate: toReadyDate,
      plantReadyDays: toPlantReadyDays,
      plantsSowed: plantsTotal,
      packetsUsed: packetsTotal,
      orderCoveredPlants: coveredTotal,
      excessPlants: excessTotal,
      sowingBufferPct: mortalityPct,
      bufferPlants: Math.round((plantsTotal * mortalityPct) / 100),
      noMortalityReserve: noMort,
      actualPlantsApplied: impact.actualPlants,
      expectedMortalityApplied: impact.expectedMortality,
      availablePlantsApplied: impact.availablePlants,
      orderReservedPlantsApplied: impact.orderReservedPlants,
      ...(Number.isFinite(Number(prevMortPct)) ? { mortalityPct: Number(prevMortPct) } : {}),
      shedName,
      sowingRequestId: request._id,
      requestNumber: request.requestNumber,
      isExcessiveSowing: Boolean(request.isExcessiveSowing),
      linkedOrderIds: request.linkedOrderIds || [],
      ...(Array.isArray(orderResult?.orderCovers) ? { orderCovers: orderResult.orderCovers } : {}),
      ...(batches[0]?.batch?.batchNumber
        ? { batchNumber: batches[0].batch.batchNumber }
        : {}),
      ...(batches[0]?.batch?.readyPlantsReceived === false
        ? { readyPlantsReceived: false }
        : batches[0]?.batch?.readyPlantsReceived === true
          ? { readyPlantsReceived: true }
          : {}),
      slotHistory: [...oldHistory, histEntry].slice(-50),
    },
  });
  await stampCoverBatchIds(request._id, pushed?.batchId, toSlotId);

  // Linked slots: drop old ready slot, keep new one (and any other links).
  const linked = new Set((request.linkedSlotIds || []).map((id) => String(id)));
  if (slotChanged && fromSlotId) linked.delete(String(fromSlotId));
  linked.add(String(toSlotId));
  request.linkedSlotIds = [...linked]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  request.sowedQuantity = plantsTotal;
  request.sowingCompletedDate = sowedAt;

  // Move linked orders (incl. DISPATCHED / COMPLETED) onto the new ready slot + history.
  let ordersMoved = { moved: 0, plants: 0, orderIds: [] };
  if (slotChanged) {
    ordersMoved = await moveLinkedOrdersBookingSlotOnSowEdit({
      orderIds: request.linkedOrderIds || [],
      sowingRequestId: request._id,
      fromSlotId,
      toSlotId,
      fromReadyDate,
      toReadyDate,
      by: userId,
      requestNumber: request.requestNumber || "",
    });
  }

  return {
    slotChanged,
    fromSlotId,
    toSlotId,
    fromReadyDate,
    toReadyDate,
    fromPlantReadyDays,
    toPlantReadyDays,
    sowingDate: sowingDateStr,
    plantsSowed: plantsTotal,
    actualPlants: impact.actualPlants,
    expectedMortality: impact.expectedMortality,
    orderCoveredPlants: coveredTotal,
    excessPlants: excessTotal,
    ordersMarked: orderResult?.marked || 0,
    partialPlants: orderResult?.partial?.addPlants || 0,
    history: histEntry,
    ordersMoved,
  };
}

async function orderIdsCoveredByRequest(request) {
  const ids = new Set((request?.linkedOrderIds || []).map((id) => String(id)).filter(Boolean));
  const reqId = request?._id;
  if (reqId) {
    const extra = await Order.find({
      $or: [
        { sowingDoneRequestId: reqId },
        { "sowingPartialCover.requestId": reqId },
        { "sowingCoverSources.sowingRequestId": reqId },
      ],
    })
      .select("_id")
      .lean();
    for (const order of extra) ids.add(String(order._id));
  }
  return [...ids]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
}

/** Drop this request's sown / partial marks so edit can cover from the new saleable pool. */
async function clearRequestOrderCover(requestId, orderIds) {
  if (!requestId || !orderIds?.length) return;
  await Order.updateMany(
    { _id: { $in: orderIds }, sowingDoneRequestId: requestId },
    {
      $set: { sowingDone: false, leftoverFromIncomplete: false },
      $unset: { sowingDoneAt: "", sowingDoneRequestId: "" },
    }
  );
  await Order.updateMany(
    { _id: { $in: orderIds } },
    {
      $pull: {
        sowingPartialCover: { requestId },
        sowingCoverSources: { sowingRequestId: requestId },
      },
    }
  );
}

/**
 * Mark outward used + create pending ReturnRequest for inventory manager approval.
 */
/** Company share of issued packets (warehouse / Ram Agri). */
export function companyPacketShare(request) {
  const fromCompany = Number(request?.packetsFromCompany) || 0;
  if (fromCompany > 0) return fromCompany;
  if (request?.seedSource === "RAISING") return 0;
  return (
    Number(request?.packetsIssued) ||
    Number(request?.packetsRequested) ||
    0
  );
}

/** Customer-seed packets allocated on the request. */
export function raisingPacketShare(request) {
  return Math.max(0, Number(request?.packetsFromRaising) || 0);
}

export function getRemainingRaisingPackets(request) {
  const total = raisingPacketShare(request);
  if (total <= 0) return 0;
  const used = Number(request?.raisingPacketsUsed) || 0;
  const returned = Number(request?.raisingPacketsReturned) || 0;
  return Math.max(0, Number((total - used - returned).toFixed(4)));
}

/**
 * Packets still open on the bag issue (not used, not returned).
 * Prefer outward line availability; fall back to request counters.
 */
export async function getRemainingCompanyPackets(request) {
  const companyPkts = companyPacketShare(request);
  if (companyPkts <= 0) return 0;

  if (request?.outwardId) {
    const outward = await InventoryOutward.findById(request.outwardId)
      .select("items.quantity items.usedQuantity")
      .lean();
    if (outward?.items?.length) {
      const avail = outward.items.reduce((sum, item) => {
        const qty = Number(item.quantity) || 0;
        const used = Number(item.usedQuantity) || 0;
        return sum + Math.max(0, qty - used);
      }, 0);
      return Math.min(companyPkts, avail);
    }
  }

  const used = Number(request.packetsUsed) || 0;
  const returned = Number(request.packetsReturned) || 0;
  return Math.max(0, companyPkts - used - returned);
}

export async function settleOutwardAndReturns(
  request,
  packetsUsed,
  packetsToReturn,
  userId
) {
  if (!request.outwardId) {
    // Issued without warehouse stock. Keep sow counters; do not create a
    // return that would add inventory that was never issued.
    const used = Math.max(0, Number(packetsUsed) || 0);
    const returned = Math.max(0, Number(packetsToReturn) || 0);
    const events = [];
    if (used > 0) {
      events.push({
        type: "PACKETS_USED",
        by: userId,
        quantity: used,
        unit: "pkt",
        message: `${used} packets used (no warehouse issue)`,
      });
    }
    if (returned > 0) {
      events.push({
        type: "PACKETS_RETURNED",
        by: userId,
        quantity: returned,
        unit: "pkt",
        message: `${returned} packets closed without inventory return`,
      });
    }
    return { used, returned, returnRequestIds: [], events };
  }
  const canReturn = companyPacketShare(request) > 0;

  const outward = await InventoryOutward.findById(request.outwardId)
    .select("items")
    .exec();
  if (!outward?.items?.length) {
    return { used: 0, returned: 0, returnRequestIds: [], events: [] };
  }

  let leftToUse = Math.max(0, packetsUsed);
  let leftToReturn = canReturn ? Math.max(0, packetsToReturn) : 0;
  let usedTotal = 0;
  let returnedTotal = 0;
  const returnDocs = [];
  const events = [];
  let rrSeq = 0;

  for (const item of outward.items) {
    const qty = Number(item.quantity) || 0;
    const already = Number(item.usedQuantity) || 0;
    const available = Math.max(0, qty - already);
    if (available <= 0) continue;

    const useNow = Math.min(available, leftToUse);
    if (useNow > 0) {
      item.usedQuantity = already + useNow;
      leftToUse -= useNow;
      usedTotal += useNow;
    }

    const stillAvail = Math.max(0, qty - (Number(item.usedQuantity) || 0));
    const retNow = Math.min(stillAvail, leftToReturn);
    if (retNow > 0.001) {
      const productId = item.product || request.productId;
      if (!productId) {
        throw new Error("Product missing for packet return");
      }
      if (!item.unit) {
        throw new Error("Outward item missing unit for packet return");
      }

      const requestNumber = quickReturnRequestNumber(rrSeq++);
      returnDocs.push({
        requestNumber,
        returnType: "sowing",
        product: productId,
        batch: item.batch || null,
        quantity: retNow,
        unit: item.unit,
        referenceType: "Sowing",
        referenceId: request._id,
        referenceNumber: request.requestNumber,
        outwardId: outward._id,
        itemId: item._id,
        originalQuantity: qty,
        usedQuantity: Number(item.usedQuantity) || 0,
        remainingQuantity: retNow,
        reason: "Sowing complete — unused company packets",
        remarks: `Pending return ${retNow} pkt from ${request.requestNumber}`,
        status: "pending",
        requestedBy: userId,
        metadata: {
          sowingRequestId: request._id,
          requestNumber: request.requestNumber,
          fromCompleteSow: true,
        },
      });

      item.usedQuantity = qty;
      leftToReturn -= retNow;
      returnedTotal += retNow;
    }
  }

  const [inserted] = await Promise.all([
    returnDocs.length
      ? ReturnRequest.insertMany(returnDocs, { ordered: false })
      : Promise.resolve([]),
    (usedTotal > 0 || returnedTotal > 0)
      ? (() => {
          outward.markModified("items");
          return outward.save();
        })()
      : Promise.resolve(null),
  ]);

  const returnRequestIds = (inserted || []).map((d) => d._id);
  for (const rr of inserted || []) {
    events.push({
      type: "PACKETS_RETURNED",
      by: userId,
      quantity: rr.quantity,
      unit: "pkt",
      message: `${rr.quantity} pkt return request created (pending inventory approval)`,
      meta: {
        returnRequestId: String(rr._id),
        returnRequestNumber: rr.requestNumber,
        status: "pending",
      },
    });
  }

  if (usedTotal > 0) {
    events.push({
      type: "PACKETS_USED",
      by: userId,
      quantity: usedTotal,
      unit: "pkt",
      message: `${usedTotal} packets used for sowing`,
    });
  }

  return { used: usedTotal, returned: returnedTotal, returnRequestIds, events };
}

function coverRowsForEntry(rows) {
  return (rows || [])
    .map((row) => {
      const plants = Math.max(0, Math.floor(Number(row?.plants) || 0));
      const id = String(row?.orderId || "");
      if (!plants || !mongoose.Types.ObjectId.isValid(id)) return null;
      return {
        orderId: new mongoose.Types.ObjectId(id),
        plants,
        partial: Boolean(row.partial),
      };
    })
    .filter(Boolean);
}

/** Cover for this sow lives on sowingentries. One $set, so the order-array conflict cannot happen here. */
async function writeCoverOnSowingEntry(request, { batchId, orderCovers, linkedOrderIds, orderCoveredPlants }) {
  if (!request?._id) return;
  const covers = coverRowsForEntry(orderCovers);
  const links = (linkedOrderIds || [])
    .map((id) => String(id || ""))
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  const coveredPlants = Math.max(0, Math.floor(Number(orderCoveredPlants) || 0));
  const set = {
    orderCovers: covers,
    linkedOrderIds: links,
    orderCoveredPlants: coveredPlants,
  };
  const batchFilter =
    batchId && mongoose.Types.ObjectId.isValid(String(batchId))
      ? { sourceBatchId: new mongoose.Types.ObjectId(String(batchId)) }
      : null;
  if (batchFilter) {
    const byBatch = await SowingEntry.updateOne(batchFilter, { $set: set });
    if (byBatch.matchedCount) return;
  }
  await SowingEntry.updateOne({ sowingRequestId: request._id }, { $set: set });
}

/** Message shown on Complete sow. Mongo driver text stays in the server log. */
export function publicCompleteSowError(error) {
  const raw = String(error?.message || "").trim();
  if (/would create a conflict at/i.test(raw)) {
    return "Could not save this sow. The cover update hit the same field twice. Try Complete sow again.";
  }
  if (/E11000|duplicate key/i.test(raw)) {
    return "Could not save this sow. This sowing entry is already saved. Refresh and try again.";
  }
  if (error?.name === "MongoServerError" || error?.name === "MongoError") {
    return "Could not save this sow. It was not marked complete. Try again.";
  }
  if (!raw || raw.length > 180) return "Could not save this sow. It was not marked complete. Try again.";
  return raw;
}

/**
 * FIFO-cover linked orders: fully covered orders get sowingDone.
 * Short remainder holds as partial sow on the next leftover order.
 * Cover pool is saleable only (sowed − CMS%). sowingDone only when
 * attributed plants ≥ order qty — never mark done from thin air.
 */
export async function markOrdersSowed(request, opts = {}) {
  const plantsSowedGross = Math.max(0, Math.floor(parseNum(opts.plantsSowed, 0)));
  if (plantsSowedGross <= 0) {
    return {
      marked: 0,
      remainingUncovered: 0,
      markedIds: [],
      batchLinkedIds: [],
      readyDate: null,
      plantReadyDays: 0,
      coverWindowDays: 0,
      eligibleCount: 0,
      incomplete: false,
      partial: null,
      waiting: [],
      orderPlantsCovered: 0,
    };
  }

  const sowedAt =
    opts.sowedAt instanceof Date && !Number.isNaN(opts.sowedAt.getTime())
      ? opts.sowedAt
      : new Date();

  let readyDays = Number(opts.plantReadyDays);
  if (!Number.isFinite(readyDays) || readyDays <= 0) {
    readyDays = await resolveCmsReadyDays(request.plantId, request.subtypeId);
  }
  readyDays = Math.max(0, Number(readyDays) || 0);
  const readyDate = addDays(sowedAt, readyDays);
  const readyDateStr = fmtDDMMYYYY(readyDate);

  const rawIds = Array.isArray(opts.orderIds) && opts.orderIds.length
    ? opts.orderIds
    : request.linkedOrderIds || [];
  const orderObjectIds = [
    ...new Set(
      rawIds
        .map((id) => String(id || ""))
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => String(id))
    ),
  ].map((id) => new mongoose.Types.ObjectId(id));

  const bufferPct =
    opts.sowingBufferPct != null && Number.isFinite(Number(opts.sowingBufferPct))
      ? Math.max(0, Number(opts.sowingBufferPct))
      : await mortalityPctForPlant(request.plantId);
  // Saleable pool only — mortality buffer is not order cover unless explicitly allowed.
  const coverPool = opts.coverPoolAlreadySaleable
    ? plantsSowedGross
    : sowCoverPool(plantsSowedGross, bufferPct);

  const empty = {
    marked: 0,
    remainingUncovered: coverPool,
    markedIds: [],
    batchLinkedIds: [],
    readyDate: readyDateStr,
    plantReadyDays: readyDays,
    coverWindowDays: 0,
    eligibleCount: 0,
    incomplete: false,
    partial: null,
    waiting: [],
    orderPlantsCovered: 0,
  };

  if (!orderObjectIds.length) return empty;

  const orders = await Order.find({
    _id: { $in: orderObjectIds },
    orderStatus: {
      $nin: ["CANCELLED", "TEMPORARY_CANCELLED", "REJECTED", "DELETED"],
    },
  })
    .select(
      "_id numberOfPlants additionalPlants deliveryDate createdAt orderId sowingPartialCover sowingCoverSources"
    )
    .sort({ deliveryDate: 1, createdAt: 1, orderId: 1 })
    .lean();

  if (!orders.length) return { ...empty, remainingUncovered: coverPool };

  let plan = planOrderSowCover({ plantsSowed: coverPool, orders });
  // Mortality finish is opt-in only — default: never mark done from buffer alone.
  if (opts.allowMortalityFill) {
    const mortalityFill =
      opts.mortalityFill != null
        ? Math.max(0, Math.floor(Number(opts.mortalityFill) || 0))
        : Math.max(0, plantsSowedGross - coverPool);
    plan = fillLastPartialFromBuffer(plan, mortalityFill);
  }
  const reqId = request._id;
  const reqNumber = String(request.requestNumber || "");
  const coverRef = await resolveCoverBatch(request, opts);
  const orderById = new Map((orders || []).map((o) => [String(o._id), o]));
  const markedIds = [];
  const orderCovers = [];
  let orderPlantsCovered = 0;

  for (const f of plan.full) {
    const raw = orderById.get(String(f.orderId));
    const addPlants = Math.max(0, Math.floor(Number(f.plants) || 0));
    const heldHere = (Array.isArray(raw?.sowingPartialCover) ? raw.sowingPartialCover : [])
      .filter((p) => String(p?.requestId || "") === String(reqId))
      .reduce((s, p) => s + Math.max(0, Math.floor(Number(p.plants) || 0)), 0);
    const priorHere = (Array.isArray(raw?.sowingCoverSources) ? raw.sowingCoverSources : [])
      .filter((s) => String(s?.sowingRequestId || "") === String(reqId))
      .reduce((s, x) => s + Math.max(0, Math.floor(Number(x.plants) || 0)), 0);
    // Keep prior attribution from this request when re-stamping after pull.
    const coveredHere = Math.max(priorHere, heldHere) + addPlants;
    const others = orderCoveredExceptRequest(raw, reqId);
    const totalAfter = others + coveredHere;
    const need = orderPlantTotal(raw);
    // Done only when this write's cover row (plus other requests) meets the order.
    // A zero-plant write must not set the flag.
    const finishesOrder = need > 0 && coveredHere > 0 && totalAfter >= need;
    if (!finishesOrder) {
      if (coveredHere > 0) {
        await Order.updateOne(
          { _id: f.orderId },
          {
            $set: { leftoverFromIncomplete: true, sowingDone: false },
            $unset: { sowingDoneAt: "", sowingDoneRequestId: "" },
            $pull: {
              sowingPartialCover: { requestId: reqId },
              sowingCoverSources: { sowingRequestId: reqId },
            },
          }
        );
        await Order.updateOne(
          { _id: f.orderId },
          {
            $push: {
              sowingPartialCover: {
                requestId: reqId,
                plants: coveredHere,
                at: sowedAt,
              },
              sowingCoverSources: coverSourceDoc({
                requestId: reqId,
                requestNumber: reqNumber,
                plants: coveredHere,
                sowingDate: fmtDDMMYYYY(sowedAt),
                plantReadyDate: readyDateStr,
                batchId: coverRef.batchId,
                slotId: coverRef.slotId,
              }),
            },
          }
        );
        orderPlantsCovered += addPlants;
        orderCovers.push({ orderId: f.orderId, plants: coveredHere, partial: true });
      }
      continue;
    }
    await Order.updateOne(
      { _id: f.orderId },
      {
        $set: { leftoverFromIncomplete: false, sowingDone: false },
        $unset: { sowingDoneAt: "", sowingDoneRequestId: "" },
        $pull: {
          sowingPartialCover: { requestId: reqId },
          sowingCoverSources: { sowingRequestId: reqId },
        },
      }
    );
    // Flag and cover row land together. The flag is not set if this push does not run.
    await Order.updateOne(
      { _id: f.orderId },
      {
        $set: {
          sowingDone: true,
          sowingDoneAt: sowedAt,
          sowingDoneRequestId: reqId,
          leftoverFromIncomplete: false,
        },
        $push: {
          sowingCoverSources: coverSourceDoc({
            requestId: reqId,
            requestNumber: reqNumber,
            plants: coveredHere,
            sowingDate: fmtDDMMYYYY(sowedAt),
            plantReadyDate: readyDateStr,
            batchId: coverRef.batchId,
            slotId: coverRef.slotId,
          }),
        },
      }
    );
    markedIds.push(f.orderId);
    orderPlantsCovered += addPlants;
    orderCovers.push({ orderId: f.orderId, plants: coveredHere, partial: false });
  }

  applyIncompleteRequestRelease(request, plan, { sowedAt });
  // linkedOrderIds should reflect what we actually marked done + partial
  if (request) {
    request.linkedOrderIds = [
      ...markedIds,
      ...(plan.partial?.orderId ? [plan.partial.orderId] : []),
    ];
  }

  if (plan.partial?.orderId && plan.partial.addPlants > 0) {
    const raw = orderById.get(String(plan.partial.orderId));
    const addPlants = Math.max(0, Math.floor(Number(plan.partial.addPlants) || 0));
    const heldHere = (Array.isArray(raw?.sowingPartialCover) ? raw.sowingPartialCover : [])
      .filter((p) => String(p?.requestId || "") === String(reqId))
      .reduce((s, p) => s + Math.max(0, Math.floor(Number(p.plants) || 0)), 0);
    const priorHere = (Array.isArray(raw?.sowingCoverSources) ? raw.sowingCoverSources : [])
      .filter((s) => String(s?.sowingRequestId || "") === String(reqId))
      .reduce((s, x) => s + Math.max(0, Math.floor(Number(x.plants) || 0)), 0);
    // Same restamp as a full cover: pull this request, then push the new total.
    // $pull and $push on sowingCoverSources in one update is a Mongo path conflict.
    const coveredHere = Math.max(priorHere, heldHere) + addPlants;
    await Order.updateOne(
      { _id: plan.partial.orderId },
      {
        $set: { leftoverFromIncomplete: true, sowingDone: false },
        $unset: { sowingDoneAt: "", sowingDoneRequestId: "" },
        $pull: {
          sowingPartialCover: { requestId: reqId },
          sowingCoverSources: { sowingRequestId: reqId },
        },
      }
    );
    await Order.updateOne(
      { _id: plan.partial.orderId },
      {
        $push: {
          sowingPartialCover: {
            requestId: reqId,
            plants: coveredHere,
            at: sowedAt,
          },
          sowingCoverSources: coverSourceDoc({
            requestId: reqId,
            requestNumber: reqNumber,
            plants: coveredHere,
            sowingDate: fmtDDMMYYYY(sowedAt),
            plantReadyDate: readyDateStr,
            batchId: coverRef.batchId,
            slotId: coverRef.slotId,
          }),
        },
      }
    );
    orderPlantsCovered += addPlants;
    orderCovers.push({
      orderId: plan.partial.orderId,
      plants: coveredHere,
      partial: true,
    });
  }

  const leftoverIds = [
    plan.partial?.orderId,
    ...(plan.waiting || []).map((w) => w.orderId),
  ].filter(Boolean);
  if (leftoverIds.length) {
    await Order.updateMany(
      { _id: { $in: leftoverIds } },
      {
        $set: { leftoverFromIncomplete: true, sowingDone: false },
        $unset: { sowingDoneAt: "", sowingDoneRequestId: "" },
      }
    );
  }

  const batchLinkedIds = [
    ...markedIds,
    ...(plan.partial?.orderId ? [plan.partial.orderId] : []),
  ];

  await writeCoverOnSowingEntry(request, {
    batchId: coverRef.batchId,
    orderCovers,
    linkedOrderIds: batchLinkedIds,
    orderCoveredPlants: orderPlantsCovered,
  });

  return {
    marked: markedIds.length,
    remainingUncovered: Math.max(0, coverPool - orderPlantsCovered),
    markedIds,
    batchLinkedIds,
    readyDate: readyDateStr,
    plantReadyDays: readyDays,
    coverWindowDays: ORDER_COVER_WINDOW_DAYS,
    eligibleCount: orders.length,
    incomplete: plan.incomplete || markedIds.length < (plan.full || []).length,
    partial: plan.partial,
    waiting: plan.waiting,
    orderPlantsCovered,
    orderCovers,
  };
}

/**
 * After excessive sow apply (all plants counted as excess): reclaim covered
 * plants from slot.excessiveSowing when nearby orders get sowingDone.
 */
export async function reclaimExcessForCoveredOrders(
  slotId,
  sowingRequestId,
  orderCoveredPlants,
  excessPlantsRemaining
) {
  const covered = Math.max(0, Math.floor(Number(orderCoveredPlants) || 0));
  const excessLeft = Math.max(0, Math.floor(Number(excessPlantsRemaining) || 0));
  if (!slotId || !sowingRequestId || covered <= 0) {
    return { excessPlants: excessLeft, orderCoveredPlants: covered };
  }
  const sid = new mongoose.Types.ObjectId(slotId);
  const rid = new mongoose.Types.ObjectId(sowingRequestId);
  const move = splitLagwadQtyForSlot(covered).actualPlants;
  const leftoverAvail = splitLagwadQtyForSlot(excessLeft).actualPlants;

  await updatePlantSlotCapped(
    {
      "subtypeSlots.slots._id": sid,
      "subtypeSlots.slots.sowingBatches.sowingRequestId": rid,
    },
    {
      $set: {
        "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].orderCoveredPlants":
          covered,
        "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].excessPlants":
          excessLeft,
        "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].availablePlantsApplied":
          leftoverAvail,
        "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].orderReservedPlantsApplied":
          move,
      },
      $inc: {
        "subtypeSlots.$[st].slots.$[sl].excessiveSowing.plants": -move,
        "subtypeSlots.$[st].slots.$[sl].availablePlants": -move,
        "subtypeSlots.$[st].slots.$[sl].orderReservedPlants": move,
      },
    },
    {
      arrayFilters: [
        { "st.slots._id": sid },
        { "sl._id": sid },
        { "b.sowingRequestId": rid },
      ],
    }
  );
  await refreshSowingEntriesOnSlot(sid, rid);
  return { excessPlants: excessLeft, orderCoveredPlants: covered };
}

export async function uploadCompleteSowPhotos(files) {
  if (!files?.length) return [];
  try {
    const { uploadMultipleImagesToLocalStorage } = await import(
      "../utils/localStorageUtils.js"
    );
    const uploads = await uploadMultipleImagesToLocalStorage(
      files,
      "sowing-complete"
    );
    return (uploads || [])
      .filter((u) => u?.url)
      .map((u) => ({
        url: u.url,
        caption: "sowing-complete",
        uploadedAt: new Date(),
      }));
  } catch (err) {
    console.warn("[complete-sow] photo upload failed:", err.message);
    return [];
  }
}
