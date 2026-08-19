import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import InventoryOutward from "../models/inventoryOutward.model.js";
import ReturnRequest from "../models/returnRequest.model.js";
import {
  fmtDDMMYYYY,
  addDays,
  resolveCmsReadyDays,
  findSlotByPlantReadyDate,
  resolveReadyDays,
  parseLocalDate,
} from "./sowingSlotReadyHelpers.js";
import { sowQtySlotImpact, splitLagwadQtyForSlot } from "../utility/lagwadSlotPlantsSplit.js";

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
export const ORDER_COVER_WINDOW_DAYS = 4;

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

export function pushEvent(request, evt) {
  if (!Array.isArray(request.completionEvents)) request.completionEvents = [];
  request.completionEvents.push({
    at: new Date(),
    ...evt,
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

  const impact = sowQtySlotImpact(qty + covered, {
    excessPlants: qty,
    orderCoveredPlants: covered,
  });
  const availInc = impact.availablePlants;
  const reservedInc = impact.orderReservedPlants;

  const update = {
    $set: {
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
  if (Object.keys(inc).length) update.$inc = inc;

  await PlantSlot.updateOne(
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
  return { excessPlants: qty, orderCoveredPlants: covered };
}

async function pushBatchToSlot(slotId, { inc, sowingDateStr, plantReadyDateStr, readyDays, batch }) {
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
  await PlantSlot.updateOne(
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
          $slice: 200,
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
}

/**
 * Fast path: lean weight read + atomic $inc/$set/$push/$pull.
 * plantReadyDate = sowDate + plantReadyDays; optionally map to calendar slot by ready date.
 */
export async function applyPlantsToLinkedSlots(request, plantsSowed, meta = {}) {
  if (plantsSowed <= 0) return { slotsUpdated: 0 };

  const packetsUsedTotal = Math.max(0, Number(meta.packetsUsed) || 0);
  const requestNumber = meta.requestNumber || request.requestNumber || "";
  const shedName = String(meta.shedName || request.shedName || "").trim();
  const linkedOrderIds = toObjectIds(
    meta.linkedOrderIds || request.linkedOrderIds || []
  );
  const isExcess = Boolean(
    meta.isExcessiveSowing ?? request.isExcessiveSowing
  );
  const bookingSlotIds = toObjectIds(request.linkedSlotIds);

  const sowedAt =
    meta.sowedAt instanceof Date && !Number.isNaN(meta.sowedAt.getTime())
      ? meta.sowedAt
      : new Date();
  const sowingDateStr = fmtDDMMYYYY(sowedAt);

  const plantId = request.plantId || meta.plantId;
  const subtypeId = request.subtypeId || meta.subtypeId;
  const cmsReadyDays = await resolveCmsReadyDays(plantId, subtypeId);
  const overrideReady = Number(meta.plantReadyDays);
  const readyDaysGlobal =
    Number.isFinite(overrideReady) && overrideReady > 0
      ? overrideReady
      : cmsReadyDays;
  const plantReadyDateStr = fmtDDMMYYYY(addDays(sowedAt, readyDaysGlobal || 0));

  // Prefer calendar slot that contains plantReadyDate (create + edit path)
  let resolvedReadySlot = null;
  if (meta.resolveByReadyDate !== false && plantId && subtypeId && readyDaysGlobal > 0) {
    resolvedReadySlot = await findSlotByPlantReadyDate(
      plantId,
      subtypeId,
      plantReadyDateStr
    );
  }

  let slotIds = bookingSlotIds;
  if (resolvedReadySlot?.slotId) {
    slotIds = [resolvedReadySlot.slotId];
    // Keep booking slots on request; also track applied ready slot
    const existing = new Set(
      (request.linkedSlotIds || []).map((id) => String(id))
    );
    if (!existing.has(String(resolvedReadySlot.slotId))) {
      request.linkedSlotIds = [
        ...(request.linkedSlotIds || []),
        resolvedReadySlot.slotId,
      ];
    }
  }

  if (!slotIds.length) {
    throw new Error("No linked slots found to apply sowing");
  }

  const rows = await PlantSlot.aggregate([
    { $match: { "subtypeSlots.slots._id": { $in: slotIds } } },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $match: { "subtypeSlots.slots._id": { $in: slotIds } } },
    {
      $project: {
        slotId: "$subtypeSlots.slots._id",
        plantId: "$plantId",
        subtypeId: "$subtypeSlots.subtypeId",
        plantReadyDays: "$subtypeSlots.slots.plantReadyDays",
        totalBookedPlants: "$subtypeSlots.slots.totalBookedPlants",
        primarySowed: "$subtypeSlots.slots.primarySowed",
        officeSowed: "$subtypeSlots.slots.officeSowed",
      },
    },
  ]);

  if (!rows.length) {
    throw new Error("No linked slots found to apply sowing");
  }

  const byId = new Map(rows.map((r) => [String(r.slotId), r]));
  const ordered = [];
  for (const id of slotIds) {
    const row = byId.get(String(id));
    if (row) ordered.push(row);
  }
  if (!ordered.length) ordered.push(...rows);

  let weightSum = 0;
  const weights = ordered.map((row) => {
    let w = 1;
    if (!isExcess && !resolvedReadySlot) {
      const booked = Number(row.totalBookedPlants) || 0;
      const sowed =
        (Number(row.primarySowed) || 0) + (Number(row.officeSowed) || 0);
      w = Math.max(1, booked - sowed);
    }
    weightSum += w;
    const readyDays = resolveReadyDays(
      meta.plantReadyDays,
      row.plantReadyDays,
      cmsReadyDays
    );
    return { slotId: row.slotId, w, readyDays };
  });

  let remainingPlants = plantsSowed;
  let remainingPackets = packetsUsedTotal;
  const updates = [];
  let appliedReadyDays = readyDaysGlobal;
  let appliedReadyDate = plantReadyDateStr;
  let appliedActual = 0;
  let appliedMortality = 0;

  for (let i = 0; i < weights.length; i++) {
    const row = weights[i];
    const isLast = i === weights.length - 1;
    const plantShare = isLast
      ? remainingPlants
      : Math.max(0, Math.round((plantsSowed * row.w) / weightSum));
    const addPlants = Math.min(plantShare, remainingPlants);
    remainingPlants -= addPlants;

    const pktShare = isLast
      ? remainingPackets
      : packetsUsedTotal > 0 && plantsSowed > 0
        ? Math.round((packetsUsedTotal * addPlants) / plantsSowed)
        : 0;
    const addPackets = Math.min(pktShare, remainingPackets);
    remainingPackets -= addPackets;

    if (addPlants <= 0) continue;

    const readyDays = row.readyDays || readyDaysGlobal || 0;
    const readyDateStr = fmtDDMMYYYY(addDays(sowedAt, readyDays));
    appliedReadyDays = readyDays;
    appliedReadyDate = readyDateStr;

    const impact = sowQtySlotImpact(addPlants, { isExcess });
    appliedActual += impact.actualPlants;
    appliedMortality += impact.expectedMortality;
    // Physical sowed stays gross; usable pool is 90% actual + 10% expected mortality
    const inc = {
      "subtypeSlots.$[st].slots.$[sl].primarySowed": addPlants,
      "subtypeSlots.$[st].slots.$[sl].totalPlants": addPlants,
      "subtypeSlots.$[st].slots.$[sl].plantsSowed": addPlants,
      "subtypeSlots.$[st].slots.$[sl].actualPlants": impact.actualPlants,
      "subtypeSlots.$[st].slots.$[sl].expectedMortality": impact.expectedMortality,
    };
    if (isExcess && impact.availablePlants > 0) {
      inc["subtypeSlots.$[st].slots.$[sl].availablePlants"] = impact.availablePlants;
    }

    const sowHistoryEntry = {
      at: sowedAt,
      by: meta.userId || null,
      fromSlotId: null,
      toSlotId: row.slotId,
      fromReadyDate: null,
      toReadyDate: readyDateStr,
      fromPlantReadyDays: null,
      toPlantReadyDays: readyDays,
      sowDate: sowingDateStr,
      plantsSowed: addPlants,
      reason: "SOW_COMPLETED",
    };

    updates.push(
      pushBatchToSlot(row.slotId, {
        inc,
        sowingDateStr,
        plantReadyDateStr: readyDateStr,
        readyDays,
        batch: {
          sowedAt,
          sowingDate: sowingDateStr,
          plantReadyDate: readyDateStr,
          plantReadyDays: readyDays,
          plantsSowed: addPlants,
          packetsUsed: addPackets,
          shedName,
          sowingRequestId: request._id,
          requestNumber,
          isExcessiveSowing: isExcess,
          orderCoveredPlants: isExcess
            ? 0
            : Math.max(
                0,
                addPlants - Math.max(0, Number(meta.excessPlants) || 0)
              ),
          excessPlants: isExcess
            ? addPlants
            : Math.max(0, Number(meta.excessPlants) || 0),
          actualPlantsApplied: impact.actualPlants,
          expectedMortalityApplied: impact.expectedMortality,
          availablePlantsApplied: isExcess ? impact.availablePlants : 0,
          orderReservedPlantsApplied: 0,
          linkedOrderIds,
          slotHistory: [sowHistoryEntry],
        },
      })
    );
  }

  if (updates.length) await Promise.all(updates);
  return {
    slotsUpdated: updates.length,
    sowingDate: sowingDateStr,
    plantReadyDays: appliedReadyDays,
    plantReadyDate: appliedReadyDate,
    appliedSlotId: resolvedReadySlot?.slotId || slotIds[0] || null,
    resolvedByReadyDate: Boolean(resolvedReadySlot),
    actualPlants: appliedActual,
    expectedMortality: appliedMortality,
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

  await PlantSlot.updateOne(
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

  const cmsReady = await resolveCmsReadyDays(request.plantId, request.subtypeId);
  const toPlantReadyDays = resolveReadyDays(
    opts.plantReadyDays,
    fromPlantReadyDays,
    cmsReady
  );
  if (!(toPlantReadyDays > 0)) {
    throw new Error("plantReadyDays must be > 0");
  }

  const sowingDateStr = fmtDDMMYYYY(sowedAt);
  const toReadyDate = fmtDDMMYYYY(addDays(sowedAt, toPlantReadyDays));
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

  // Restore reserved vs saleable from previous batch totals
  let coveredTotal = 0;
  let excessTotal = 0;
  for (const row of batches) {
    coveredTotal += Math.max(0, Number(row.batch?.orderCoveredPlants) || 0);
    excessTotal += Math.max(0, Number(row.batch?.excessPlants) || 0);
  }
  if (Boolean(request.isExcessiveSowing) && excessTotal <= 0 && coveredTotal <= 0) {
    excessTotal = plantsTotal;
  } else if (coveredTotal + excessTotal <= 0) {
    // Unknown split — treat as reserved if linked orders else saleable
    if ((request.linkedOrderIds || []).length) {
      coveredTotal = plantsTotal;
    } else {
      excessTotal = plantsTotal;
    }
  }

  const isExcess =
    Boolean(request.isExcessiveSowing) && coveredTotal <= 0;
  const impact = sowQtySlotImpact(plantsTotal, {
    isExcess,
    excessPlants: excessTotal,
    orderCoveredPlants: coveredTotal,
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

  await pushBatchToSlot(toSlotId, {
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
      actualPlantsApplied: impact.actualPlants,
      expectedMortalityApplied: impact.expectedMortality,
      availablePlantsApplied: impact.availablePlants,
      orderReservedPlantsApplied: impact.orderReservedPlants,
      shedName,
      sowingRequestId: request._id,
      requestNumber: request.requestNumber,
      isExcessiveSowing: Boolean(request.isExcessiveSowing),
      linkedOrderIds: request.linkedOrderIds || [],
      slotHistory: [...oldHistory, histEntry].slice(-50),
    },
  });

  // Ensure ready slot is on request
  const linked = new Set((request.linkedSlotIds || []).map((id) => String(id)));
  linked.add(String(toSlotId));
  request.linkedSlotIds = [...linked].map((id) => new mongoose.Types.ObjectId(id));
  request.sowedQuantity = plantsTotal;
  request.sowingCompletedDate = sowedAt;

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
    history: histEntry,
  };
}

/**
 * Mark outward used + create pending ReturnRequest for inventory manager approval.
 */
/** Company share of issued packets (raising seed is never returned). */
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
    return { used: 0, returned: 0, returnRequestIds: [], events: [] };
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

/**
 * Mark orders sowingDone=true for orders included on this sow only.
 *
 * Eligible = opts.orderIds (if provided) else request.linkedOrderIds.
 * No ±N delivery-date auto-cover — only orders attached to the sowing.
 * Excess / saleable = plantsSowed − sum(included order plants).
 */
export async function markOrdersSowed(request, opts = {}) {
  const plantsSowed = Math.max(0, Math.floor(parseNum(opts.plantsSowed, 0)));
  if (plantsSowed <= 0) {
    return {
      marked: 0,
      remainingUncovered: 0,
      markedIds: [],
      readyDate: null,
      plantReadyDays: 0,
      coverWindowDays: 0,
      eligibleCount: 0,
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

  if (!orderObjectIds.length) {
    return {
      marked: 0,
      remainingUncovered: plantsSowed,
      markedIds: [],
      readyDate: readyDateStr,
      plantReadyDays: readyDays,
      coverWindowDays: 0,
      eligibleCount: 0,
    };
  }

  const orders = await Order.find({
    _id: { $in: orderObjectIds },
    sowingDone: { $ne: true },
    orderStatus: {
      $nin: ["CANCELLED", "TEMPORARY_CANCELLED", "REJECTED", "DELETED"],
    },
  })
    .select("_id numberOfPlants additionalPlants deliveryDate createdAt orderId")
    .sort({ deliveryDate: 1, createdAt: 1, orderId: 1 })
    .lean();

  const toMark = orders.map((o) => o._id);
  const coveredNeed = orders.reduce(
    (s, o) =>
      s + (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0),
    0
  );
  const remainingUncovered = Math.max(0, plantsSowed - coveredNeed);

  if (!toMark.length) {
    return {
      marked: 0,
      remainingUncovered: plantsSowed,
      markedIds: [],
      readyDate: readyDateStr,
      plantReadyDays: readyDays,
      coverWindowDays: 0,
      eligibleCount: 0,
    };
  }

  const result = await Order.updateMany(
    {
      _id: { $in: toMark },
      sowingDone: { $ne: true },
    },
    {
      $set: {
        sowingDone: true,
        sowingDoneAt: sowedAt,
        sowingDoneRequestId: request._id,
      },
    }
  );

  // Keep request.linkedOrderIds = orders marked by this request
  const allMarkedForReq = await Order.find({
    sowingDoneRequestId: request._id,
  })
    .select("_id")
    .lean();
  request.linkedOrderIds = allMarkedForReq.map((o) => o._id);

  return {
    marked: result.modifiedCount || 0,
    remainingUncovered,
    markedIds: toMark,
    readyDate: readyDateStr,
    plantReadyDays: readyDays,
    coverWindowDays: 0,
    eligibleCount: orders.length,
    orderPlantsCovered: coveredNeed,
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

  await PlantSlot.updateOne(
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
