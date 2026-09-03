import mongoose from "mongoose";
import moment from "moment";
import PlantSlot from "../models/slots.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import Sowing from "../models/sowing.model.js";
import { findDeliverySlotByDate } from "../utility/findDeliverySlot.js";
import { applyStockFieldUpdates } from "../utility/slotStockTrail.js";
import {
  computeLagwadPendingSlotSync,
  splitLagwadQtyForSlot,
} from "../utility/lagwadSlotPlantsSplit.js";
import { buildSowingMatchForSingleBatch } from "../utility/sowingBatchMatch.js";
import { isSlotContainingDate } from "./pastDueSlotRollover.service.js";

const normBatchNumber = (v) => {
  const s = v != null ? String(v).trim() : "";
  return s || null;
};

/** R1/R2 lagwad → shorter secondary hardening; R3 → longer (different booking slot). */
export const DEFAULT_SECONDARY_R1_READY_DAYS = 30;
export const DEFAULT_SECONDARY_R3_READY_DAYS = 40;

export function secondaryReadyDaysForSize(size, batchLean) {
  const base = Number(batchLean?.secondaryPlantReadyDays) || 0;
  const r1Days = base > 0 ? base : DEFAULT_SECONDARY_R1_READY_DAYS;
  const r3Explicit = Number(batchLean?.secondaryR3PlantReadyDays) || 0;
  const r3Days =
    r3Explicit > 0 ? r3Explicit : DEFAULT_SECONDARY_R3_READY_DAYS;
  if (String(size ?? "").toUpperCase() === "R3") return r3Days;
  return r1Days;
}

export function expectedReadyDateForSecondarySize(inwardDate, size, batchLean) {
  const inward = inwardDate ? moment(inwardDate).startOf("day") : null;
  if (!inward?.isValid()) return null;
  const days = secondaryReadyDaysForSize(size, batchLean);
  return inward.clone().add(days, "days").toDate();
}

/** ERP sellable position: actual plants minus booked-but-not-dispatched. */
export function computeActualAvailable(actualPlants, remainingToDispatch) {
  return Math.max(
    0,
    (Number(actualPlants) || 0) - (Number(remainingToDispatch) || 0)
  );
}

/** Plants in shed line not yet reflected on booking slot.actualPlants. */
export function computePendingSlotSync(availableQuantity, slotStockSyncedPlants) {
  const avail = Math.max(0, Number(availableQuantity) || 0);
  const synced = Math.max(0, Number(slotStockSyncedPlants) || 0);
  return Math.max(0, avail - synced);
}

/** Dispatch/unload math for slotStockSyncedPlants (ready position). */
export function computeReadyPositionSubtract(syncedPlants, quantity) {
  const synced = Math.max(0, Math.floor(Number(syncedPlants) || 0));
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  const subtracted = Math.min(qty, synced);
  return {
    subtracted,
    newSynced: Math.max(0, synced - subtracted),
  };
}

export function computeReadyPositionRestore(availableQuantity, syncedPlants, quantity) {
  const avail = Math.max(0, Math.floor(Number(availableQuantity) || 0));
  const synced = Math.max(0, Math.floor(Number(syncedPlants) || 0));
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  const headroom = Math.max(0, avail - synced);
  const restored = Math.min(qty, headroom);
  return {
    restored,
    newSynced: synced + restored,
  };
}

/** Normal lagwad sync: 90% → actual + ready; 10% → expected mortality. */
export function simulateLagwadSlotSync(availableQuantity, slotStockSyncedPlants) {
  const lagwadSync = computeLagwadPendingSlotSync(
    availableQuantity,
    slotStockSyncedPlants
  );
  const split = splitLagwadQtyForSlot(availableQuantity);
  const mortalityInc =
    lagwadSync.pending > 0 && split.actualPlants > 0
      ? Math.round(
          (split.expectedMortality * lagwadSync.pending) / split.actualPlants
        )
      : 0;
  return {
    pending: lagwadSync.pending,
    actualPlantsDelta: lagwadSync.actualPlantsDelta,
    expectedMortalityDelta: mortalityInc,
    readyDelta: lagwadSync.readyDelta,
    lagwadRemainingDelta: lagwadSync.lagwadRemainingDelta,
    syncedAfter: lagwadSync.syncedAfter,
    readyOnly: false,
  };
}

/** Dispatch subtracts actualReadyPlants on slot — not actualPlants. */
export function simulateDispatchLagwadRemaining(slotActualReady, dispatchQty) {
  const ready = Math.max(0, Math.floor(Number(slotActualReady) || 0));
  const qty = Math.max(0, Math.floor(Number(dispatchQty) || 0));
  const subtracted = Math.min(qty, ready);
  const actualReadyAfter = Math.max(0, ready - subtracted);
  return {
    subtracted,
    actualReadyAfter,
    lagwadRemainingAfter: actualReadyAfter,
    actualPlantsDelta: 0,
    actualReadyDelta: -subtracted,
  };
}

/**
 * Vehicle dispatch path: readyPositionOnly sync then subtract ready — actualPlants unchanged.
 */
export function simulateDispatchReadyOnSlot(line, dispatchQty) {
  const avail = Math.max(0, Number(line?.availableQuantity) || 0);
  const syncedBefore = Math.max(0, Number(line?.slotStockSyncedPlants) || 0);
  const dispatch = Math.max(0, Math.floor(Number(dispatchQty) || 0));
  const pending = computePendingSlotSync(avail, syncedBefore);
  const syncedAfterSync = syncedBefore + pending;
  const sub = computeReadyPositionSubtract(syncedAfterSync, dispatch);
  return {
    availBefore: avail,
    availAfter: Math.max(0, avail - dispatch),
    syncedBefore,
    syncApplied: pending,
    syncedAfterSync,
    subtracted: sub.subtracted,
    syncedAfter: sub.newSynced,
    actualPlantsDelta: 0,
  };
}

/** Vehicle unload path: restore ready synced only. */
export function simulateUnloadReadyOnSlot(line, unloadQty) {
  const avail = Math.max(0, Number(line?.availableQuantity) || 0);
  const syncedBefore = Math.max(0, Number(line?.slotStockSyncedPlants) || 0);
  const rest = computeReadyPositionRestore(avail, syncedBefore, unloadQty);
  return {
    avail,
    syncedBefore,
    restored: rest.restored,
    syncedAfter: rest.newSynced,
    actualPlantsDelta: 0,
  };
}

/**
 * Pure rollup of secondary inward lines → per-slot shed totals (no DB).
 */
export function secondaryInwardCalendarReady(si, batchLean, todayStart) {
  if (si?.readinessBypassAt != null && moment(si.readinessBypassAt).isValid()) {
    return true;
  }
  const days = secondaryReadyDaysForSize(si?.size, batchLean);
  const inward = si?.secondaryInwardDate
    ? moment(si.secondaryInwardDate).startOf("day")
    : null;
  if (!inward?.isValid()) return false;
  const expected =
    si?.expectedReadyDate && moment(si.expectedReadyDate).isValid()
      ? moment(si.expectedReadyDate).startOf("day")
      : inward.clone().add(days, "days");
  return todayStart.isSameOrAfter(expected, "day");
}

export function rollupShedStockForSlots(posLean, slotIdStrings) {
  const todayStart = moment().startOf("day");
  const map = new Map();
  for (const sid of slotIdStrings || []) {
    map.set(String(sid), {
      shedSyncedPlants: 0,
      shedAvailableInShed: 0,
      actualReadyPlants: 0,
      shedReadyInShed: 0,
      linkedBatchIds: new Set(),
      lineCount: 0,
    });
  }
  for (const po of posLean || []) {
    const batchId = po.batchId?._id ?? po.batchId;
    const batchLean =
      po.batchId && typeof po.batchId === "object" ? po.batchId : null;
    for (const si of po.secondaryInward || []) {
      const slotKey = si.linkedBookingSlotId ? String(si.linkedBookingSlotId) : "";
      if (!map.has(slotKey)) continue;
      const agg = map.get(slotKey);
      const avail = Math.max(0, Number(si.availableQuantity) || 0);
      const synced = Math.max(0, Number(si.slotStockSyncedPlants) || 0);
      const calendarReady = secondaryInwardCalendarReady(si, batchLean, todayStart);
      agg.shedAvailableInShed += avail;
      agg.shedSyncedPlants += synced;
      if (calendarReady) {
        agg.actualReadyPlants += synced;
        agg.shedReadyInShed += avail;
      }
      agg.lineCount += 1;
      if (batchId) agg.linkedBatchIds.add(String(batchId));
    }
  }
  const out = new Map();
  for (const [k, v] of map) {
    out.set(k, {
      shedSyncedPlants: v.shedSyncedPlants,
      shedAvailableInShed: v.shedAvailableInShed,
      actualReadyPlants: v.actualReadyPlants,
      shedReadyInShed: v.shedReadyInShed,
      linkedBatchCount: v.linkedBatchIds.size,
      lineCount: v.lineCount,
    });
  }
  return out;
}

const BATCH_SELECT =
  "batchNumber dateAdded primaryPlantReadyDays secondaryPlantReadyDays plantCmsId plantSubtypeId";

function plantSubtypeLabels(batchLean) {
  if (!batchLean) return { plantLabel: "—", subtypeLabel: "—" };
  const plant = batchLean.plantCmsId;
  const sid = batchLean.plantSubtypeId;
  if (!plant || typeof plant === "string" || !plant.name) {
    return { plantLabel: "—", subtypeLabel: "—" };
  }
  const sub = (plant.subtypes || []).find((s) => String(s._id) === String(sid));
  return {
    plantLabel: plant.name || "—",
    subtypeLabel: sub?.name || "—",
  };
}

function resolveSubtypeNameFromPlant(subtypeSlot, plantLean) {
  if (!subtypeSlot) return "";
  const fromSlot = subtypeSlot.subtypeName || subtypeSlot.name || "";
  if (fromSlot) return fromSlot;
  const sid = subtypeSlot.subtypeId;
  if (!sid || !plantLean?.subtypes) return "";
  const sub = plantLean.subtypes.find((s) => String(s._id) === String(sid));
  return sub?.name || "";
}

function fmtDayLabel(isoOrMoment) {
  if (!isoOrMoment) return null;
  const m = moment.isMoment(isoOrMoment) ? isoOrMoment : moment(isoOrMoment);
  return m.isValid() ? m.format("DD MMM YYYY") : null;
}

/** Fill batch timeline from inward lines when sowing anchor is missing. */
function enrichBatchGroupTimeline(group) {
  const lines = group.lines || [];
  if (!lines.length) return group;

  const inwardMoments = lines
    .map((ln) => (ln.secondaryInwardDate ? moment(ln.secondaryInwardDate).startOf("day") : null))
    .filter((m) => m?.isValid());
  const expectedMoments = lines
    .map((ln) => (ln.expectedReadyDate ? moment(ln.expectedReadyDate).startOf("day") : null))
    .filter((m) => m?.isValid());

  if (!group.anchorSowingLabel && inwardMoments.length) {
    const earliest = inwardMoments.reduce((a, b) => (a.isBefore(b) ? a : b));
    group.lagwadAnchorDate = earliest.format("YYYY-MM-DD");
    group.lagwadAnchorLabel = earliest.format("DD MMM YYYY");
  }

  if (!group.secondaryReadyDate && expectedMoments.length) {
    const ready = expectedMoments[0];
    group.secondaryReadyDate = ready.format("YYYY-MM-DD");
    group.secondaryReadyLabel = ready.format("DD MMM YYYY");
  } else if (group.secondaryReadyDate && !group.secondaryReadyLabel) {
    group.secondaryReadyLabel = fmtDayLabel(group.secondaryReadyDate);
  }

  if (group.primaryReadyDate && !group.primaryReadyLabel) {
    group.primaryReadyLabel = fmtDayLabel(group.primaryReadyDate);
  }

  return group;
}

function parseSowingDateToMoment(raw) {
  if (!raw) return null;
  const m = moment(raw, ["DD-MM-YYYY", "YYYY-MM-DD", moment.ISO_8601], true);
  return m.isValid() ? m.startOf("day") : null;
}

async function earliestSowingAnchorByBatchId(batchIds) {
  const map = new Map();
  if (!batchIds.length) return map;

  const batches = await DispatchBatch.find({ _id: { $in: batchIds } })
    .select(BATCH_SELECT)
    .lean();

  await Promise.all(
    batches.map(async (b) => {
      const bn = normBatchNumber(b.batchNumber);
      const filter = buildSowingMatchForSingleBatch(b._id, bn);
      if (!filter) return;
      const rows = await Sowing.find(filter).select("sowingDate batchNumber").lean();
      let anchor = null;
      for (const row of rows) {
        const m = parseSowingDateToMoment(row.sowingDate);
        if (!m) continue;
        if (!anchor || m.isBefore(anchor)) anchor = m;
      }
      const primaryDays = Number(b.primaryPlantReadyDays) || 0;
      const secondaryDays = Number(b.secondaryPlantReadyDays) || 0;
      map.set(String(b._id), {
        batchNumber: bn || String(b.batchNumber || ""),
        anchorSowingDate: anchor ? anchor.format("YYYY-MM-DD") : null,
        anchorSowingLabel: anchor ? anchor.format("DD MMM YYYY") : null,
        primaryReadyDate: anchor
          ? anchor.clone().add(primaryDays, "days").format("YYYY-MM-DD")
          : null,
        secondaryReadyDate: anchor
          ? anchor.clone().add(primaryDays + secondaryDays, "days").format("YYYY-MM-DD")
          : null,
        primaryPlantReadyDays: primaryDays,
        secondaryPlantReadyDays: secondaryDays,
      });
    })
  );
  return map;
}

/**
 * Per-slot aggregates for stock-entry table (linked secondary inward lines).
 */
export async function aggregateShedStockBySlotIds(slotObjectIds) {
  if (!slotObjectIds?.length) return new Map();

  const oids = slotObjectIds
    .filter((id) => id && mongoose.isValidObjectId(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));

  const pos = await PlantOutward.find({
    "secondaryInward.linkedBookingSlotId": { $in: oids },
  })
    .select("batchId secondaryInward")
    .populate({ path: "batchId", select: BATCH_SELECT })
    .lean();

  return rollupShedStockForSlots(
    pos,
    oids.map((id) => String(id))
  );
}

/** Days a line is past its expected ready date (0 when not yet due). */
export function overdueDaysForExpectedReady(expectedMoment, todayStart) {
  if (!expectedMoment?.isValid?.()) return 0;
  if (todayStart.isBefore(expectedMoment, "day")) return 0;
  return todayStart.diff(expectedMoment, "days");
}

/**
 * One lagwad inward line as the ERP UI consumes it (drill-down + analysis).
 * Shared by the single-slot breakdown and the multi-slot lagwad analysis.
 */
export function buildSecondaryInwardLine(si, po, batchLean, todayStart) {
  const secDays = Number(batchLean?.secondaryPlantReadyDays) || 0;
  const avail = Math.max(0, Number(si.availableQuantity) || 0);
  const synced = Math.max(0, Number(si.slotStockSyncedPlants) || 0);
  const totalQuantity = Math.max(0, Number(si.totalQuantity) || 0);
  const inward = si.secondaryInwardDate
    ? moment(si.secondaryInwardDate).startOf("day")
    : null;
  const expected =
    si.expectedReadyDate && moment(si.expectedReadyDate).isValid()
      ? moment(si.expectedReadyDate).startOf("day")
      : inward
        ? inward.clone().add(secDays, "days")
        : null;
  const bypass = si.readinessBypassAt != null;
  const calendarEligible = Boolean(expected && todayStart.isSameOrAfter(expected, "day"));
  const dispatchEligible = calendarEligible || bypass;
  const pendingSlotSync = computePendingSlotSync(avail, synced);
  const slotSyncStatus =
    synced <= 0 ? "pending" : pendingSlotSync > 0 ? "partial" : "synced";
  const split = splitLagwadQtyForSlot(totalQuantity);

  return {
    secondaryInwardId: si._id,
    plantOutwardId: po._id,
    secondaryInwardDate: si.secondaryInwardDate,
    lagwadDate: si.secondaryInwardDate,
    lagwadLabel: fmtDayLabel(si.secondaryInwardDate),
    expectedReadyDate: expected ? expected.toISOString() : null,
    expectedReadyLabel: expected ? expected.format("DD MMM YYYY") : null,
    dateOfDispatch: si.dateOfDispatch ?? null,
    dateOfDispatchLabel: fmtDayLabel(si.dateOfDispatch),
    pollyhouse: si.pollyhouse,
    size: si.size,
    cavity: si.cavity,
    numberOfTrays: si.numberOfTrays,
    totalQuantity,
    availableQuantity: avail,
    slotStockSyncedPlants: synced,
    onSlotPlants: synced,
    pendingSlotSync,
    slotSyncStatus,
    dispatchEligible,
    onSlot: synced > 0,
    readinessBypassAt: si.readinessBypassAt ?? null,
    // Lagwad analysis additions — 90/10 split, ready age and readiness state.
    sell90: split.actualPlants,
    mort10: split.expectedMortality,
    calendarReady: calendarEligible,
    overdueDays: calendarEligible ? overdueDaysForExpectedReady(expected, todayStart) : 0,
    readyStatus: calendarEligible ? "ready" : bypass ? "legacy_bypass" : "awaiting",
  };
}

/**
 * Flat lagwad lines across many booking slots, each tagged with its slotId.
 * One PlantOutward query for the whole selection (month / multi-slot analysis).
 */
export async function getSecondaryShedLinesForSlots(slotIds) {
  const oids = (slotIds || [])
    .filter((id) => id && mongoose.isValidObjectId(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!oids.length) return [];

  const wanted = new Set(oids.map((id) => String(id)));
  const pos = await PlantOutward.find({
    "secondaryInward.linkedBookingSlotId": { $in: oids },
  })
    .populate({
      path: "batchId",
      select: BATCH_SELECT,
      populate: { path: "plantCmsId", select: "name subtypes" },
    })
    .lean();

  const todayStart = moment().startOf("day");
  const lines = [];

  for (const po of pos) {
    const batchLean = po.batchId && typeof po.batchId === "object" ? po.batchId : null;
    const batchIdStr = batchLean?._id ? String(batchLean._id) : String(po.batchId || "");
    const labels = plantSubtypeLabels(batchLean);

    for (const si of po.secondaryInward || []) {
      const slotKey = si.linkedBookingSlotId ? String(si.linkedBookingSlotId) : "";
      if (!wanted.has(slotKey)) continue;
      lines.push({
        ...buildSecondaryInwardLine(si, po, batchLean, todayStart),
        slotId: slotKey,
        batchId: batchIdStr,
        batchNumber: batchLean?.batchNumber ?? batchIdStr,
        plantLabel: labels.plantLabel,
        subtypeLabel: labels.subtypeLabel,
      });
    }
  }

  return lines;
}

/**
 * Batch-wise secondary shed lines linked to a booking slot (for ERP UI drill-down).
 */
export async function getSlotSecondaryShedBreakdown(slotId) {
  if (!slotId || !mongoose.isValidObjectId(String(slotId))) {
    return null;
  }
  const slotOid = new mongoose.Types.ObjectId(String(slotId));
  const plantSlotDoc = await PlantSlot.findOne({
    "subtypeSlots.slots._id": slotOid,
  })
    .populate("plantId", "name subtypes")
    .lean();
  if (!plantSlotDoc) return null;

  const plantLean =
    plantSlotDoc.plantId && typeof plantSlotDoc.plantId === "object"
      ? plantSlotDoc.plantId
      : null;

  let slot = null;
  let subtypeName = "";
  for (const st of plantSlotDoc.subtypeSlots || []) {
    const found = (st.slots || []).find(
      (s) => String(s._id) === String(slotId)
    );
    if (found) {
      slot = found;
      subtypeName = resolveSubtypeNameFromPlant(st, plantLean);
      break;
    }
  }
  if (!slot) return null;

  const plantName =
    plantSlotDoc.plantId && typeof plantSlotDoc.plantId === "object"
      ? plantSlotDoc.plantId.name || ""
      : "";

  const pos = await PlantOutward.find({
    "secondaryInward.linkedBookingSlotId": slotOid,
  })
    .populate({
      path: "batchId",
      select: BATCH_SELECT,
      populate: { path: "plantCmsId", select: "name subtypes" },
    })
    .lean();

  const batchIds = [
    ...new Set(
      pos
        .map((po) => po.batchId?._id ?? po.batchId)
        .filter((id) => id && mongoose.isValidObjectId(String(id)))
        .map(String)
    ),
  ].map((id) => new mongoose.Types.ObjectId(id));

  const sowingMap = await earliestSowingAnchorByBatchId(batchIds);
  const today = moment().startOf("day");
  const batchGroups = new Map();

  for (const po of pos) {
    const batchLean = po.batchId && typeof po.batchId === "object" ? po.batchId : null;
    const batchIdStr = batchLean?._id ? String(batchLean._id) : String(po.batchId || "");
    if (!batchGroups.has(batchIdStr)) {
      const sow = sowingMap.get(batchIdStr) || {};
      const labels = plantSubtypeLabels(batchLean);
      batchGroups.set(batchIdStr, {
        batchId: batchIdStr,
        batchNumber: batchLean?.batchNumber ?? sow.batchNumber ?? batchIdStr,
        plantLabel: labels.plantLabel,
        subtypeLabel: labels.subtypeLabel,
        anchorSowingDate: sow.anchorSowingDate ?? null,
        anchorSowingLabel: sow.anchorSowingLabel ?? null,
        primaryReadyDate: sow.primaryReadyDate ?? null,
        secondaryReadyDate: sow.secondaryReadyDate ?? null,
        primaryPlantReadyDays: sow.primaryPlantReadyDays ?? 0,
        secondaryPlantReadyDays: sow.secondaryPlantReadyDays ?? 0,
        lines: [],
        totalAvailableInShed: 0,
        totalSyncedToSlot: 0,
        totalPlantsInward: 0,
      });
    }
    const group = batchGroups.get(batchIdStr);

    for (const si of po.secondaryInward || []) {
      if (String(si.linkedBookingSlotId) !== String(slotId)) continue;
      const line = buildSecondaryInwardLine(si, po, batchLean, today);
      group.lines.push(line);
      group.totalAvailableInShed += line.availableQuantity;
      group.totalSyncedToSlot += line.slotStockSyncedPlants;
      group.totalPlantsInward += line.totalQuantity;
    }
  }

  const batches = [...batchGroups.values()]
    .filter((b) => b.lines.length > 0)
    .map(enrichBatchGroupTimeline)
    .sort((a, b) =>
      String(a.batchNumber).localeCompare(String(b.batchNumber), undefined, {
        numeric: true,
      })
    );

  const summary = batches.reduce(
    (acc, b) => {
      acc.shedAvailableInShed += b.totalAvailableInShed;
      acc.shedSyncedToSlot += b.totalSyncedToSlot;
      acc.pendingSlotSync += b.lines.reduce(
        (s, ln) => s + (ln.pendingSlotSync || 0),
        0
      );
      for (const ln of b.lines) {
        if (ln.dispatchEligible) {
          acc.actualReadyPlants += ln.slotStockSyncedPlants || 0;
          acc.shedReadyInShed += ln.availableQuantity || 0;
        }
      }
      return acc;
    },
    {
      shedAvailableInShed: 0,
      shedSyncedToSlot: 0,
      actualReadyPlants: 0,
      shedReadyInShed: 0,
      pendingSlotSync: 0,
      batchCount: batches.length,
      lineCount: batches.reduce((s, b) => s + b.lines.length, 0),
    }
  );

  const actualPlants = Math.max(0, Number(slot.actualPlants) || 0);
  summary.actualPlants = actualPlants;
  summary.expectedMortality = Math.max(0, Number(slot.expectedMortality) || 0);
  summary.actualReadyPlantsStored = Math.max(0, Number(slot.actualReadyPlants) || 0);
  summary.lagwadRemaining = Math.max(0, Number(slot.lagwadRemaining) || 0);

  return {
    slot: {
      _id: slot._id,
      startDay: slot.startDay,
      endDay: slot.endDay,
      month: slot.month,
      plantName,
      subtypeName,
      year: plantSlotDoc.year,
      actualPlants,
      expectedMortality: summary.expectedMortality,
      actualReadyPlants: summary.actualReadyPlantsStored,
      lagwadRemaining: summary.lagwadRemaining,
      availablePlants: Number(slot.availablePlants) || 0,
      plantsSowed: Number(slot.plantsSowed) || 0,
    },
    summary,
    batches,
  };
}

/**
 * Resolve booking slot (date window) for secondary ready / dispatch date.
 */
export async function resolveBookingSlotIdForSecondaryBatch(batchLean, readyDate) {
  if (!batchLean || !readyDate) return null;
  const plantCmsId = batchLean.plantCmsId?._id ?? batchLean.plantCmsId;
  const plantSubtypeId = batchLean.plantSubtypeId?._id ?? batchLean.plantSubtypeId;
  if (!plantCmsId || !plantSubtypeId) return null;
  if (!mongoose.isValidObjectId(String(plantCmsId))) return null;
  if (!mongoose.isValidObjectId(String(plantSubtypeId))) return null;

  const m = moment(readyDate);
  if (!m.isValid()) return null;

  try {
    const slot = await findDeliverySlotByDate(plantCmsId, plantSubtypeId, m.toDate());
    return slot?._id ?? null;
  } catch (err) {
    console.warn(
      "[secondaryShedSlotStock] No booking slot for ready date:",
      m.format("YYYY-MM-DD"),
      err?.message || err
    );
    return null;
  }
}

async function loadSlotSubdoc(slotId, session) {
  if (!slotId || !mongoose.isValidObjectId(String(slotId))) return null;
  const plantSlot = await PlantSlot.findOne({
    "subtypeSlots.slots._id": slotId,
  }).session(session || null);
  if (!plantSlot) return null;
  for (const subtype of plantSlot.subtypeSlots || []) {
    const slot = subtype.slots.id(slotId);
    if (slot) return { plantSlot, slot };
  }
  return null;
}

export function pickReadyDateForSlot(siPlain, batchLean) {
  if (siPlain?.expectedReadyDate && moment(siPlain.expectedReadyDate).isValid()) {
    return moment(siPlain.expectedReadyDate);
  }
  if (siPlain?.dateOfDispatch && moment(siPlain.dateOfDispatch).isValid()) {
    return moment(siPlain.dateOfDispatch);
  }
  const inward = siPlain?.secondaryInwardDate
    ? moment(siPlain.secondaryInwardDate).startOf("day")
    : null;
  const days = secondaryReadyDaysForSize(siPlain?.size, batchLean);
  if (inward?.isValid()) return inward.clone().add(days, "days");
  return null;
}

/**
 * Add unsynced plants from a secondary inward line to slot.actualPlants (target slot = inward + ready days).
 * Called at lagwad/inward (force) and when calendar-dispatch-eligible unless already synced.
 */
export async function syncSecondaryInwardSlotStockAdd({
  session,
  batchId,
  secondaryInwardId,
  batchLean,
  siPlain,
  dispatchEligible,
  force = false,
  performedBy,
  /** Late ready: bump actualReady only (not actual/mortality again). */
  readyPositionOnly = false,
}) {
  const avail = Math.max(0, Number(siPlain?.availableQuantity) || 0);
  const synced = Math.max(0, Number(siPlain?.slotStockSyncedPlants) || 0);
  const lagwadSync = computeLagwadPendingSlotSync(avail, synced);
  const pending = lagwadSync.pending;
  if (pending < 1) return { applied: 0, slotId: siPlain?.linkedBookingSlotId ?? null };

  if (!force && !dispatchEligible) {
    return { applied: 0, slotId: siPlain?.linkedBookingSlotId ?? null, skipped: "not_eligible" };
  }

  const todayStart = moment().startOf("day");
  if (secondaryInwardCalendarReady(siPlain, batchLean, todayStart)) {
    const currentSlotId = await resolveBookingSlotIdForSecondaryBatch(
      batchLean,
      todayStart.toDate()
    );
    const linked = siPlain?.linkedBookingSlotId
      ? String(siPlain.linkedBookingSlotId)
      : null;
    if (currentSlotId && linked && linked !== String(currentSlotId)) {
      return await relocateSecondaryInwardSlotOnCalendarReady({
        session,
        batchId,
        secondaryInwardId,
        batchLean,
        siPlain,
        performedBy,
      });
    }
  }

  let slotId = siPlain?.linkedBookingSlotId;
  const readyMoment = pickReadyDateForSlot(siPlain, batchLean);
  if (!slotId && readyMoment?.isValid()) {
    slotId = await resolveBookingSlotIdForSecondaryBatch(batchLean, readyMoment.toDate());
  }
  if (!slotId) {
    return { applied: 0, slotId: null, skipped: "no_slot" };
  }

  const bn =
    batchLean?.batchNumber != null ? String(batchLean.batchNumber) : String(batchId);

  if (readyPositionOnly) {
    const loaded = await loadSlotSubdoc(slotId, session);
    if (loaded && pending > 0) {
      const { plantSlot, slot } = loaded;
      const prevReady = Math.max(0, Number(slot.actualReadyPlants) || 0);
      applyStockFieldUpdates(
        slot,
        {
          actualReadyPlants: prevReady + pending,
        },
        performedBy,
        `Secondary ready · batch ${bn} (+${pending} ready)`
      );
      if (performedBy && mongoose.isValidObjectId(String(performedBy))) {
        slot.setPerformer?.(performedBy);
      }
      await plantSlot.save({ session: session || undefined, validateBeforeSave: true });
    }

    await PlantOutward.updateOne(
      { batchId, "secondaryInward._id": secondaryInwardId },
      {
        $set: {
          "secondaryInward.$.linkedBookingSlotId": slotId,
          "secondaryInward.$.slotStockSyncedPlants": synced + pending,
        },
      },
      { session: session || undefined }
    );
    return { applied: pending, slotId: String(slotId), readyOnly: true };
  }

  const loaded = await loadSlotSubdoc(slotId, session);
  if (!loaded) {
    return { applied: 0, slotId, skipped: "slot_not_found" };
  }

  const { plantSlot, slot } = loaded;
  const split = splitLagwadQtyForSlot(avail);
  const mortalityInc =
    pending > 0 && split.actualPlants > 0
      ? Math.round((split.expectedMortality * pending) / split.actualPlants)
      : 0;
  const eligibleReady = dispatchEligible;
  const prevActual = Math.max(0, Number(slot.actualPlants) || 0);
  const prevMortality = Math.max(0, Number(slot.expectedMortality) || 0);
  const prevReady = Math.max(0, Number(slot.actualReadyPlants) || 0);

  const updates = {
    actualPlants: prevActual + pending,
    expectedMortality: prevMortality + mortalityInc,
  };
  if (eligibleReady && pending > 0) {
    updates.actualReadyPlants = prevReady + pending;
  }

  applyStockFieldUpdates(
    slot,
    updates,
    performedBy,
    `Secondary lagwad · batch ${bn} (+${pending} actual, +${mortalityInc} exp. mortality)`
  );

  if (performedBy && mongoose.isValidObjectId(String(performedBy))) {
    slot.setPerformer?.(performedBy);
  }

  await plantSlot.save({ session: session || undefined, validateBeforeSave: true });

  await PlantOutward.updateOne(
    { batchId, "secondaryInward._id": secondaryInwardId },
    {
      $set: {
        "secondaryInward.$.linkedBookingSlotId": slotId,
        "secondaryInward.$.slotStockSyncedPlants": synced + pending,
      },
    },
    { session: session || undefined }
  );

  return {
    applied: pending,
    mortalityApplied: mortalityInc,
    slotId: String(slotId),
  };
}

/**
 * Dispatch: subtract actualReadyPlants on slot — actualPlants unchanged.
 */
export async function subtractSecondaryInwardSlotStock({
  session,
  batchId,
  secondaryInwardId,
  batchLean,
  siPlain,
  quantity,
  performedBy,
}) {
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  if (qty < 1) return { subtracted: 0 };

  const slotId = siPlain?.linkedBookingSlotId;
  if (!slotId) {
    return { subtracted: 0, skipped: "no_linked_slot" };
  }

  const loaded = await loadSlotSubdoc(slotId, session);
  if (!loaded) {
    return { subtracted: 0, skipped: "slot_not_found", slotId: String(slotId) };
  }

  const { plantSlot, slot } = loaded;
  const prevReady = Math.max(0, Number(slot.actualReadyPlants) || 0);
  const subtracted = Math.min(qty, prevReady);
  if (subtracted < 1) {
    return { subtracted: 0, skipped: "no_actual_ready", slotId: String(slotId) };
  }

  const bn =
    batchLean?.batchNumber != null ? String(batchLean.batchNumber) : String(batchId);

  applyStockFieldUpdates(
    slot,
    { actualReadyPlants: prevReady - subtracted },
    performedBy,
    `Dispatch · batch ${bn} (−${subtracted} actual ready)`
  );

  if (performedBy && mongoose.isValidObjectId(String(performedBy))) {
    slot.setPerformer?.(performedBy);
  }

  await plantSlot.save({ session: session || undefined, validateBeforeSave: true });

  return {
    subtracted,
    slotId: String(slotId),
    actualReadyOnly: true,
    message: `Actual ready −${subtracted} (batch ${bn}); actualPlants unchanged`,
  };
}

/**
 * Unload: restore actualReadyPlants on slot (not actualPlants).
 */
export async function restoreSecondaryInwardSlotStock({
  session,
  batchId,
  secondaryInwardId,
  batchLean,
  siPlain,
  quantity,
  performedBy,
}) {
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  if (qty < 1) return { restored: 0 };

  const slotId = siPlain?.linkedBookingSlotId;
  if (!slotId) {
    return { restored: 0, skipped: "no_linked_slot" };
  }

  const loaded = await loadSlotSubdoc(slotId, session);
  if (!loaded) {
    return { restored: 0, skipped: "slot_not_found", slotId: String(slotId) };
  }

  const { plantSlot, slot } = loaded;
  const prevReady = Math.max(0, Number(slot.actualReadyPlants) || 0);
  const restored = qty;
  const bn =
    batchLean?.batchNumber != null ? String(batchLean.batchNumber) : String(batchId);

  applyStockFieldUpdates(
    slot,
    { actualReadyPlants: prevReady + restored },
    performedBy,
    `Unload · batch ${bn} (+${restored} actual ready)`
  );

  if (performedBy && mongoose.isValidObjectId(String(performedBy))) {
    slot.setPerformer?.(performedBy);
  }

  await plantSlot.save({ session: session || undefined, validateBeforeSave: true });

  return {
    restored,
    slotId: String(slotId),
    actualReadyOnly: true,
    message: `Actual ready +${restored} (batch ${bn}); actualPlants unchanged`,
  };
}

/** Move expected mortality → actual ready when plants survive. */
export async function transferSlotExpectedMortalityToReady({
  session,
  slotId,
  quantity,
  performedBy,
  source = "Mortality transfer to ready",
}) {
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  if (qty < 1) return { transferred: 0 };

  const loaded = await loadSlotSubdoc(slotId, session);
  if (!loaded) return { transferred: 0, skipped: "slot_not_found" };

  const { plantSlot, slot } = loaded;
  const prevMortality = Math.max(0, Number(slot.expectedMortality) || 0);
  const transferred = Math.min(qty, prevMortality);
  if (transferred < 1) {
    return { transferred: 0, skipped: "no_expected_mortality" };
  }

  const prevReady = Math.max(0, Number(slot.actualReadyPlants) || 0);

  applyStockFieldUpdates(
    slot,
    {
      expectedMortality: prevMortality - transferred,
      actualReadyPlants: prevReady + transferred,
    },
    performedBy,
    source
  );

  if (performedBy && mongoose.isValidObjectId(String(performedBy))) {
    slot.setPerformer?.(performedBy);
  }

  await plantSlot.save({ session: session || undefined, validateBeforeSave: true });

  return { transferred, slotId: String(slotId) };
}

/**
 * Undo full lagwad sync on a slot: actual + mortality + ready for synced portion.
 */
export async function undoSecondaryInwardFullSlotSync({
  session,
  batchId,
  secondaryInwardId,
  batchLean,
  siPlain,
  performedBy,
}) {
  const synced = Math.max(0, Number(siPlain?.slotStockSyncedPlants) || 0);
  if (synced < 1) return { undone: 0 };

  const slotId = siPlain?.linkedBookingSlotId;
  if (!slotId) return { undone: 0, skipped: "no_linked_slot" };

  const avail = Math.max(0, Number(siPlain?.availableQuantity) || 0);
  const split = splitLagwadQtyForSlot(avail);
  const mortalityCalc =
    split.actualPlants > 0
      ? Math.round((split.expectedMortality * synced) / split.actualPlants)
      : 0;

  const loaded = await loadSlotSubdoc(slotId, session);
  if (!loaded) {
    return { undone: 0, skipped: "slot_not_found", slotId: String(slotId) };
  }

  const { plantSlot, slot } = loaded;
  const prevActual = Math.max(0, Number(slot.actualPlants) || 0);
  const prevMortality = Math.max(0, Number(slot.expectedMortality) || 0);
  const prevReady = Math.max(0, Number(slot.actualReadyPlants) || 0);

  const actualDec = Math.min(synced, prevActual);
  const mortalityDec = Math.min(mortalityCalc, prevMortality);
  const readyDec = Math.min(synced, prevReady);

  const bn =
    batchLean?.batchNumber != null ? String(batchLean.batchNumber) : String(batchId);

  applyStockFieldUpdates(
    slot,
    {
      actualPlants: prevActual - actualDec,
      expectedMortality: prevMortality - mortalityDec,
      actualReadyPlants: prevReady - readyDec,
    },
    performedBy,
    `Secondary slot undo · batch ${bn} (−${actualDec} actual, −${mortalityDec} mort, −${readyDec} ready)`
  );

  if (performedBy && mongoose.isValidObjectId(String(performedBy))) {
    slot.setPerformer?.(performedBy);
  }

  await plantSlot.save({ session: session || undefined, validateBeforeSave: true });

  return {
    undone: synced,
    actualDec,
    mortalityDec,
    readyDec,
    slotId: String(slotId),
  };
}

/** Calendar ready: move full inward sync to current ongoing booking slot. */
export async function relocateSecondaryInwardSlotOnCalendarReady({
  session,
  batchId,
  secondaryInwardId,
  batchLean,
  siPlain,
  performedBy,
}) {
  const today = moment().startOf("day");
  if (!secondaryInwardCalendarReady(siPlain, batchLean, today)) {
    return { applied: 0, skipped: "not_calendar_ready" };
  }

  const currentSlotId = await resolveBookingSlotIdForSecondaryBatch(
    batchLean,
    today.toDate()
  );
  if (!currentSlotId) {
    return { applied: 0, skipped: "no_current_slot" };
  }

  const oldSlotId = siPlain?.linkedBookingSlotId
    ? String(siPlain.linkedBookingSlotId)
    : null;
  const currentStr = String(currentSlotId);

  if (oldSlotId === currentStr) {
    return await syncSecondaryInwardSlotStockAdd({
      session,
      batchId,
      secondaryInwardId,
      batchLean,
      siPlain,
      dispatchEligible: true,
      force: false,
      performedBy,
    });
  }

  const synced = Math.max(0, Number(siPlain?.slotStockSyncedPlants) || 0);
  if (synced > 0 && oldSlotId) {
    await undoSecondaryInwardFullSlotSync({
      session,
      batchId,
      secondaryInwardId,
      batchLean,
      siPlain,
      performedBy,
    });
    await PlantOutward.updateOne(
      { batchId, "secondaryInward._id": secondaryInwardId },
      { $set: { "secondaryInward.$.slotStockSyncedPlants": 0 } },
      { session: session || undefined }
    );
    siPlain.slotStockSyncedPlants = 0;
  }

  await PlantOutward.updateOne(
    { batchId, "secondaryInward._id": secondaryInwardId },
    { $set: { "secondaryInward.$.linkedBookingSlotId": currentSlotId } },
    { session: session || undefined }
  );
  siPlain.linkedBookingSlotId = currentSlotId;

  const syncResult = await syncSecondaryInwardSlotStockAdd({
    session,
    batchId,
    secondaryInwardId,
    batchLean,
    siPlain,
    dispatchEligible: true,
    force: true,
    performedBy,
  });

  return {
    ...syncResult,
    oldSlotId,
    newSlotId: currentStr,
    relocated: true,
    reason: "Calendar ready → current slot",
  };
}

/**
 * Mark-ready bypass: undo prior slot sync, re-link to today's booking slot, sync plants.
 */
export async function relocateSecondaryInwardSlotOnBypass({
  batchId,
  secondaryInwardId,
  batchLean,
  siPlain,
  performedBy,
}) {
  const synced = Math.max(0, Number(siPlain?.slotStockSyncedPlants) || 0);
  const oldSlotId = siPlain?.linkedBookingSlotId
    ? String(siPlain.linkedBookingSlotId)
    : null;

  if (synced > 0 && oldSlotId) {
    await undoSecondaryInwardFullSlotSync({
      batchId,
      secondaryInwardId,
      batchLean,
      siPlain,
      performedBy,
    });
    await PlantOutward.updateOne(
      { batchId, "secondaryInward._id": secondaryInwardId },
      { $set: { "secondaryInward.$.slotStockSyncedPlants": 0 } }
    );
    siPlain.slotStockSyncedPlants = 0;
  }

  const todaySlotId = await resolveBookingSlotIdForSecondaryBatch(
    batchLean,
    new Date()
  );
  if (!todaySlotId) {
    return {
      applied: 0,
      slotId: null,
      oldSlotId,
      skipped: "no_today_slot",
    };
  }

  await PlantOutward.updateOne(
    { batchId, "secondaryInward._id": secondaryInwardId },
    {
      $set: {
        "secondaryInward.$.linkedBookingSlotId": todaySlotId,
        "secondaryInward.$.slotStockSyncedPlants": 0,
      },
    }
  );
  siPlain.linkedBookingSlotId = todaySlotId;
  siPlain.slotStockSyncedPlants = 0;

  const syncResult = await syncSecondaryInwardSlotStockAdd({
    batchId,
    secondaryInwardId,
    batchLean,
    siPlain,
    dispatchEligible: true,
    force: true,
    performedBy,
  });

  return {
    ...syncResult,
    oldSlotId,
    newSlotId: String(todaySlotId),
  };
}

/** API detail payload: slot sync status + human booking-slot label for ERP / mobile. */
export async function buildBookingSlotLabelMap(slotIds) {
  const oids = [
    ...new Set(
      (slotIds || [])
        .filter((id) => id && mongoose.isValidObjectId(String(id)))
        .map((id) => new mongoose.Types.ObjectId(String(id)))
    ),
  ];
  const map = new Map();
  if (!oids.length) return map;

  const wanted = new Set(oids.map((o) => String(o)));
  const plantSlotDocs = await PlantSlot.find({
    "subtypeSlots.slots._id": { $in: oids },
  })
    .populate("plantId", "name")
    .lean();

  for (const plantSlotDoc of plantSlotDocs) {
    const plantName =
      plantSlotDoc.plantId && typeof plantSlotDoc.plantId === "object"
        ? plantSlotDoc.plantId.name || ""
        : "";
    for (const st of plantSlotDoc.subtypeSlots || []) {
      for (const slot of st.slots || []) {
        const sid = String(slot._id);
        if (!wanted.has(sid)) continue;
        const window =
          slot?.startDay && slot?.endDay
            ? `${slot.startDay}-${slot.endDay}`
            : slot?.startDay || slot?.endDay || "";
        const label = [window, slot?.month, plantSlotDoc.year]
          .filter(Boolean)
          .join(" ")
          .trim();
        map.set(sid, {
          slotId: sid,
          label: label || `Slot …${sid.slice(-6)}`,
          startDay: slot.startDay ?? null,
          endDay: slot.endDay ?? null,
          month: slot.month ?? null,
          year: plantSlotDoc.year ?? null,
          plantName,
        });
      }
    }
  }

  for (const oid of oids) {
    const sid = String(oid);
    if (!map.has(sid)) {
      map.set(sid, { slotId: sid, label: `Slot …${sid.slice(-6)}` });
    }
  }
  return map;
}

export function applyBookingSlotLabelToPlain(siPlain, labelMap) {
  const out = { ...(siPlain || {}) };
  const slotId = out.linkedBookingSlotId
    ? String(out.linkedBookingSlotId)
    : null;
  if (!slotId) {
    out.bookingSlot = null;
    out.bookingSlotLabel = null;
    return out;
  }
  const info = labelMap.get(slotId) || {
    slotId,
    label: `Slot …${slotId.slice(-6)}`,
  };
  out.bookingSlot = info;
  out.bookingSlotLabel = info.label;
  return out;
}

/** Attach booking-slot labels to secondaryInward[] on outward list payloads. */
export async function enrichPlantOutwardsWithBookingSlotLabels(outwards) {
  const slotIds = [];
  for (const po of outwards || []) {
    const o = typeof po.toObject === "function" ? po.toObject() : po;
    for (const si of o.secondaryInward || []) {
      if (si?.linkedBookingSlotId) slotIds.push(si.linkedBookingSlotId);
    }
  }
  const labelMap = await buildBookingSlotLabelMap(slotIds);
  return (outwards || []).map((po) => {
    const o = typeof po.toObject === "function" ? po.toObject() : { ...po };
    if (Array.isArray(o.secondaryInward)) {
      o.secondaryInward = o.secondaryInward.map((si) =>
        applyBookingSlotLabelToPlain(
          typeof si.toObject === "function" ? si.toObject() : si,
          labelMap
        )
      );
    }
    return o;
  });
}

/** Dashboard secondary lines: label on line + nested secondaryInward. */
export async function attachBookingSlotLabelsToDashboardLines(lines) {
  const slotIds = (lines || []).map((l) => l.secondaryInward?.linkedBookingSlotId);
  const labelMap = await buildBookingSlotLabelMap(slotIds);
  return (lines || []).map((line) => {
    const si =
      line.secondaryInward &&
      typeof line.secondaryInward.toObject === "function"
        ? line.secondaryInward.toObject()
        : { ...(line.secondaryInward || {}) };
    const enriched = applyBookingSlotLabelToPlain(si, labelMap);
    return {
      ...line,
      secondaryInward: enriched,
      bookingSlot: enriched.bookingSlot,
      bookingSlotLabel: enriched.bookingSlotLabel,
      linkedBookingSlotId:
        enriched.linkedBookingSlotId ?? line.linkedBookingSlotId,
    };
  });
}

export async function enrichSecondaryInwardDetail(siPlain) {
  const plain = { ...(siPlain || {}) };
  const avail = Math.max(0, Number(plain.availableQuantity) || 0);
  const synced = Math.max(0, Number(plain.slotStockSyncedPlants) || 0);
  const pending = computePendingSlotSync(avail, synced);
  plain.pendingSlotSync = pending;
  plain.slotSyncStatus =
    synced <= 0 ? "pending" : pending > 0 ? "partial" : "synced";

  const slotId = plain.linkedBookingSlotId;
  if (!slotId || !mongoose.isValidObjectId(String(slotId))) {
    plain.bookingSlot = null;
    return plain;
  }

  const plantSlotDoc = await PlantSlot.findOne({
    "subtypeSlots.slots._id": slotId,
  })
    .populate("plantId", "name")
    .lean();

  if (!plantSlotDoc) {
    plain.bookingSlot = {
      slotId: String(slotId),
      label: `Slot …${String(slotId).slice(-6)}`,
    };
    return plain;
  }

  let slot = null;
  for (const st of plantSlotDoc.subtypeSlots || []) {
    const found = (st.slots || []).find((s) => String(s._id) === String(slotId));
    if (found) {
      slot = found;
      break;
    }
  }

  const plantName =
    plantSlotDoc.plantId && typeof plantSlotDoc.plantId === "object"
      ? plantSlotDoc.plantId.name || ""
      : "";

  const window =
    slot?.startDay && slot?.endDay
      ? `${slot.startDay}-${slot.endDay}`
      : slot?.startDay || slot?.endDay || "";
  const label = [window, slot?.month, plantSlotDoc.year]
    .filter(Boolean)
    .join(" ")
    .trim();

  plain.bookingSlot = {
    slotId: String(slotId),
    label: label || `Slot …${String(slotId).slice(-6)}`,
    startDay: slot?.startDay ?? null,
    endDay: slot?.endDay ?? null,
    month: slot?.month ?? null,
    year: plantSlotDoc.year ?? null,
    actualPlants: Math.max(0, Number(slot?.actualPlants) || 0),
    plantName,
  };
  return plain;
}

/**
 * Move ready position (slotStockSyncedPlants) from source slot inward lines → target.
 * Keeps actualPlants on slot unchanged; slot.actualReadyPlants is updated separately in roll service.
 */
export async function transferSecondaryReadyShedBetweenSlots({
  session,
  sourceSlotId,
  targetSlotId,
  quantity,
}) {
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  if (qty < 1) return { transferred: 0, shortfall: qty };

  const sourceOid = new mongoose.Types.ObjectId(String(sourceSlotId));
  const targetOid = new mongoose.Types.ObjectId(String(targetSlotId));

  const pos = await PlantOutward.find({
    "secondaryInward.linkedBookingSlotId": sourceOid,
  })
    .populate({ path: "batchId", select: BATCH_SELECT })
    .session(session)
    .lean();

  const lines = [];
  for (const po of pos) {
    const batchLean = po.batchId && typeof po.batchId === "object" ? po.batchId : null;
    const batchId = batchLean?._id ?? po.batchId;
    for (const si of po.secondaryInward || []) {
      if (String(si.linkedBookingSlotId) !== String(sourceSlotId)) continue;
      const synced = Math.max(0, Number(si.slotStockSyncedPlants) || 0);
      if (synced < 1) continue;
      lines.push({
        plantOutwardId: po._id,
        batchId,
        batchLean,
        secondaryInwardId: si._id,
        synced,
        siPlain: si,
      });
    }
  }

  lines.sort((a, b) => {
    const da = a.siPlain?.expectedReadyDate
      ? new Date(a.siPlain.expectedReadyDate).getTime()
      : 0;
    const db = b.siPlain?.expectedReadyDate
      ? new Date(b.siPlain.expectedReadyDate).getTime()
      : 0;
    return da - db;
  });

  let remaining = qty;
  let transferred = 0;

  for (const ln of lines) {
    if (remaining < 1) break;
    const take = Math.min(remaining, ln.synced);
    const newSourceSynced = ln.synced - take;
    const fullLineMove = newSourceSynced === 0 && take === ln.synced;

    if (fullLineMove) {
      await PlantOutward.updateOne(
        { _id: ln.plantOutwardId, "secondaryInward._id": ln.secondaryInwardId },
        {
          $set: {
            "secondaryInward.$.linkedBookingSlotId": targetOid,
            "secondaryInward.$.slotStockSyncedPlants": take,
          },
        },
        { session: session || undefined }
      );
    } else {
      await PlantOutward.updateOne(
        { _id: ln.plantOutwardId, "secondaryInward._id": ln.secondaryInwardId },
        {
          $set: {
            "secondaryInward.$.slotStockSyncedPlants": newSourceSynced,
          },
        },
        { session: session || undefined }
      );

      const targetPo = await PlantOutward.findOne({
        batchId: ln.batchId,
        "secondaryInward.linkedBookingSlotId": targetOid,
      }).session(session);

      const targetLine = (targetPo?.secondaryInward || []).find(
        (si) => String(si.linkedBookingSlotId) === String(targetSlotId)
      );

      if (targetLine) {
        const curSynced = Math.max(0, Number(targetLine.slotStockSyncedPlants) || 0);
        await PlantOutward.updateOne(
          { _id: targetPo._id, "secondaryInward._id": targetLine._id },
          {
            $set: {
              "secondaryInward.$.slotStockSyncedPlants": curSynced + take,
            },
          },
          { session: session || undefined }
        );
      }
    }

    remaining -= take;
    transferred += take;
  }

  return { transferred, shortfall: remaining };
}

/** Max rollable ready = max(slot field, shed synced rollup on calendar-ready lines). */
export async function getSlotReadyRollCapacity(slotId, slotLean = null) {
  const slotReady = Math.max(0, Number(slotLean?.actualReadyPlants) || 0);
  if (!slotId || !mongoose.isValidObjectId(String(slotId))) return slotReady;
  const shedMap = await aggregateShedStockBySlotIds([
    new mongoose.Types.ObjectId(String(slotId)),
  ]);
  const shedReady = shedMap.get(String(slotId))?.actualReadyPlants ?? 0;
  return Math.max(slotReady, shedReady);
}
