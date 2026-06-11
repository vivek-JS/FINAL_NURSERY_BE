import mongoose from "mongoose";
import moment from "moment";
import PlantSlot from "../models/slots.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import Sowing from "../models/sowing.model.js";
import { findDeliverySlotByDate } from "../utility/findDeliverySlot.js";
import { applyStockFieldUpdates } from "../utility/slotStockTrail.js";
import { buildSowingMatchForSingleBatch } from "../utility/sowingBatchMatch.js";

const normBatchNumber = (v) => {
  const s = v != null ? String(v).trim() : "";
  return s || null;
};

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

/**
 * Pure rollup of secondary inward lines → per-slot shed totals (no DB).
 */
export function rollupShedStockForSlots(posLean, slotIdStrings) {
  const map = new Map();
  for (const sid of slotIdStrings || []) {
    map.set(String(sid), {
      shedSyncedPlants: 0,
      shedAvailableInShed: 0,
      linkedBatchIds: new Set(),
      lineCount: 0,
    });
  }
  for (const po of posLean || []) {
    const batchId = po.batchId?._id ?? po.batchId;
    for (const si of po.secondaryInward || []) {
      const slotKey = si.linkedBookingSlotId ? String(si.linkedBookingSlotId) : "";
      if (!map.has(slotKey)) continue;
      const agg = map.get(slotKey);
      const avail = Math.max(0, Number(si.availableQuantity) || 0);
      const synced = Math.max(0, Number(si.slotStockSyncedPlants) || 0);
      agg.shedAvailableInShed += avail;
      agg.shedSyncedPlants += synced;
      agg.lineCount += 1;
      if (batchId) agg.linkedBatchIds.add(String(batchId));
    }
  }
  const out = new Map();
  for (const [k, v] of map) {
    out.set(k, {
      shedSyncedPlants: v.shedSyncedPlants,
      shedAvailableInShed: v.shedAvailableInShed,
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
    .lean();

  return rollupShedStockForSlots(
    pos,
    oids.map((id) => String(id))
  );
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
    .populate("plantId", "name")
    .lean();
  if (!plantSlotDoc) return null;

  let slot = null;
  let subtypeName = "";
  for (const st of plantSlotDoc.subtypeSlots || []) {
    const found = (st.slots || []).find(
      (s) => String(s._id) === String(slotId)
    );
    if (found) {
      slot = found;
      subtypeName = st.subtypeName || st.name || "";
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
    const secDays = Number(batchLean?.secondaryPlantReadyDays) || 0;

    for (const si of po.secondaryInward || []) {
      if (String(si.linkedBookingSlotId) !== String(slotId)) continue;
      const avail = Math.max(0, Number(si.availableQuantity) || 0);
      const synced = Math.max(0, Number(si.slotStockSyncedPlants) || 0);
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
      const calendarEligible =
        expected && today.isSameOrAfter(expected, "day");
      const dispatchEligible = calendarEligible || bypass;

      group.lines.push({
        secondaryInwardId: si._id,
        plantOutwardId: po._id,
        secondaryInwardDate: si.secondaryInwardDate,
        expectedReadyDate: expected ? expected.toISOString() : null,
        pollyhouse: si.pollyhouse,
        size: si.size,
        cavity: si.cavity,
        numberOfTrays: si.numberOfTrays,
        availableQuantity: avail,
        slotStockSyncedPlants: synced,
        pendingSlotSync: computePendingSlotSync(avail, synced),
        dispatchEligible,
        readinessBypassAt: si.readinessBypassAt ?? null,
      });
      group.totalAvailableInShed += avail;
      group.totalSyncedToSlot += synced;
      group.totalPlantsInward += Math.max(0, Number(si.totalQuantity) || 0);
    }
  }

  const batches = [...batchGroups.values()]
    .filter((b) => b.lines.length > 0)
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
      return acc;
    },
    {
      shedAvailableInShed: 0,
      shedSyncedToSlot: 0,
      pendingSlotSync: 0,
      batchCount: batches.length,
      lineCount: batches.reduce((s, b) => s + b.lines.length, 0),
    }
  );

  const actualPlants = Math.max(0, Number(slot.actualPlants) || 0);
  summary.actualPlants = actualPlants;

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
  const days = Number(batchLean?.secondaryPlantReadyDays) || 0;
  if (inward?.isValid()) return inward.clone().add(days, "days");
  return null;
}

/**
 * Add unsynced dispatch-eligible plants from a secondary inward line to slot.actualPlants.
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
}) {
  const avail = Math.max(0, Number(siPlain?.availableQuantity) || 0);
  const synced = Math.max(0, Number(siPlain?.slotStockSyncedPlants) || 0);
  const pending = computePendingSlotSync(avail, synced);
  if (pending < 1) return { applied: 0, slotId: siPlain?.linkedBookingSlotId ?? null };

  if (!force && !dispatchEligible) {
    return { applied: 0, slotId: siPlain?.linkedBookingSlotId ?? null, skipped: "not_eligible" };
  }

  let slotId = siPlain?.linkedBookingSlotId;
  const readyMoment = pickReadyDateForSlot(siPlain, batchLean);
  if (!slotId && readyMoment?.isValid()) {
    slotId = await resolveBookingSlotIdForSecondaryBatch(batchLean, readyMoment.toDate());
  }
  if (!slotId) {
    return { applied: 0, slotId: null, skipped: "no_slot" };
  }

  const loaded = await loadSlotSubdoc(slotId, session);
  if (!loaded) {
    return { applied: 0, slotId, skipped: "slot_not_found" };
  }

  const { plantSlot, slot } = loaded;
  const prevActual = Math.max(0, Number(slot.actualPlants) || 0);
  const nextActual = prevActual + pending;
  const bn = batchLean?.batchNumber != null ? String(batchLean.batchNumber) : String(batchId);

  applyStockFieldUpdates(
    slot,
    { actualPlants: nextActual },
    performedBy,
    `Secondary shed ready · batch ${bn} (+${pending} plants)`
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

  return { applied: pending, slotId: String(slotId) };
}

/**
 * Subtract plants leaving secondary shed from slot.actualPlants (ERP sellable position).
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
    return { subtracted: 0, skipped: "slot_not_found" };
  }

  const { plantSlot, slot } = loaded;
  const prevActual = Math.max(0, Number(slot.actualPlants) || 0);
  const nextActual = Math.max(0, prevActual - qty);
  const synced = Math.max(0, Number(siPlain?.slotStockSyncedPlants) || 0);
  const newSynced = Math.max(0, synced - qty);
  const bn = batchLean?.batchNumber != null ? String(batchLean.batchNumber) : String(batchId);

  applyStockFieldUpdates(
    slot,
    { actualPlants: nextActual },
    performedBy,
    `Secondary dispatch · batch ${bn} (−${qty} plants)`
  );

  if (performedBy && mongoose.isValidObjectId(String(performedBy))) {
    slot.setPerformer?.(performedBy);
  }

  await plantSlot.save({ session: session || undefined, validateBeforeSave: true });

  await PlantOutward.updateOne(
    { batchId, "secondaryInward._id": secondaryInwardId },
    {
      $set: {
        "secondaryInward.$.slotStockSyncedPlants": newSynced,
      },
    },
    { session: session || undefined }
  );

  return { subtracted: qty, slotId: String(slotId) };
}

/**
 * Return plants unloaded from a vehicle back to the source booking slot (mirror of subtract).
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
    return { restored: 0, skipped: "slot_not_found" };
  }

  const { plantSlot, slot } = loaded;
  const prevActual = Math.max(0, Number(slot.actualPlants) || 0);
  const nextActual = prevActual + qty;
  const synced = Math.max(0, Number(siPlain?.slotStockSyncedPlants) || 0);
  const newSynced = synced + qty;
  const bn = batchLean?.batchNumber != null ? String(batchLean.batchNumber) : String(batchId);

  applyStockFieldUpdates(
    slot,
    { actualPlants: nextActual },
    performedBy,
    `Secondary unload · batch ${bn} (+${qty} plants)`
  );

  if (performedBy && mongoose.isValidObjectId(String(performedBy))) {
    slot.setPerformer?.(performedBy);
  }

  await plantSlot.save({ session: session || undefined, validateBeforeSave: true });

  await PlantOutward.updateOne(
    { batchId, "secondaryInward._id": secondaryInwardId },
    {
      $set: {
        "secondaryInward.$.slotStockSyncedPlants": newSynced,
      },
    },
    { session: session || undefined }
  );

  return { restored: qty, slotId: String(slotId) };
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
    await subtractSecondaryInwardSlotStock({
      batchId,
      secondaryInwardId,
      batchLean,
      siPlain,
      quantity: synced,
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
