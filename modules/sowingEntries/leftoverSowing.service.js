import mongoose from "mongoose";
import PlantSlot from "../../models/slots.model.js";
import SowingEntry from "../../models/sowingEntry.model.js";
import { findSowBatchForRequest } from "../../controllers/sowingCompleteHelpers.js";
import { applyStockFieldUpdates } from "../../utility/slotStockTrail.js";
import AppError from "../../utility/appError.js";
import { sowBatchLeft } from "../../services/sowBatchDestroy.service.js";
import { pickNextSowing, restamp, withMarked, withSowed } from "./leftoverSowingMath.js";

const int = (value) => Math.max(0, Math.floor(Number(value) || 0));
const signed = (value) => {
  const n = Math.trunc(Number(value) || 0);
  return Number.isFinite(n) ? n : 0;
};

const FIGURE_KEYS = [
  "plantsSowed",
  "sowingBufferPct",
  "bufferPlants",
  "noMortalityReserve",
  "excessPlants",
  "remainingPlants",
  "plantsTransferredOut",
  "plantsTransferredIn",
  "plantsMarkedSellable",
  "destroyedPlants",
];

function assignFigures(entry, next) {
  for (const key of FIGURE_KEYS) {
    if (next[key] !== undefined) entry[key] = next[key];
  }
}

function pushLog(entry, log) {
  if (!Array.isArray(entry.transferLog)) entry.transferLog = [];
  entry.transferLog.push(log);
}

async function loadEntry(id) {
  if (!mongoose.Types.ObjectId.isValid(String(id || ""))) {
    throw new AppError("Invalid entry id", 400);
  }
  const entry = await SowingEntry.findById(id);
  if (!entry) throw new AppError("Sowing entry not found", 404);
  if (entry.isIrrelevant) throw new AppError("This sowing is marked old", 400);
  return entry;
}

async function candidatesFor(entry) {
  const filter = {
    plantId: entry.plantId,
    _id: { $ne: entry._id },
    isIrrelevant: { $ne: true },
  };
  if (entry.subtypeId) filter.subtypeId = entry.subtypeId;
  return SowingEntry.find(filter)
    .select(
      "requestNumber plantName subtypeName plantReadyDate sowDay sowingDate plantsSowed bufferPlants sowingBufferPct noMortalityReserve orderCoveredPlants dispatchedPlants destroyedPlants plantsMarkedSellable mortalityMovedToExcess excessMovedToMortality isIrrelevant"
    )
    .lean();
}

function publicNext(row) {
  if (!row) return null;
  const stamped = restamp(row);
  return {
    _id: String(row._id),
    requestNumber: row.requestNumber || "",
    plantName: row.plantName || "",
    subtypeName: row.subtypeName || "",
    plantReadyDate: row.plantReadyDate || "",
    sowingDate: row.sowDay || row.sowingDate || "",
    excessPlants: stamped.excessPlants,
    remainingPlants: stamped.remainingPlants,
  };
}

async function batchLocation(entry) {
  if (!entry?.sowingRequestId) return null;
  const found = await findSowBatchForRequest(entry.sowingRequestId);
  const hit = found?.[0];
  if (!hit?.batch?._id || !hit.slotId) return null;
  const batch = hit.batch;
  const remaining = restamp(entry.toObject ? entry.toObject() : entry).remainingPlants;
  const left = sowBatchLeft(batch);
  return {
    slotId: String(hit.slotId),
    batchId: String(batch._id),
    plantsSowed: int(batch.plantsSowed),
    destroyedPlants: int(batch.destroyedPlants),
    plantsLeft: Math.min(left, remaining),
    requestNumber: batch.requestNumber || entry.requestNumber || "",
    sowingDate: batch.sowingDate || "",
    shedName: batch.shedName || entry.shedName || "",
  };
}

export async function leftoverPreview(entryId) {
  const entry = await loadEntry(entryId);
  const stamped = restamp(entry.toObject());
  const next = pickNextSowing(entry, await candidatesFor(entry));
  return {
    remaining: stamped.remainingPlants,
    excess: stamped.excessPlants,
    requestNumber: entry.requestNumber || "",
    plantReadyDate: entry.plantReadyDate || "",
    batch: await batchLocation(entry),
    next: publicNext(next),
  };
}

function takeQuantity(entry, plants) {
  const qty = int(plants);
  const remaining = restamp(entry.toObject()).remainingPlants;
  if (qty < 1) throw new AppError("Enter how many plants to move", 400);
  if (qty > remaining) throw new AppError(`Only ${remaining} plants are still here`, 400);
  return qty;
}

function logRow({ plants, direction, other, by }) {
  return {
    at: new Date(),
    by: by && mongoose.Types.ObjectId.isValid(String(by)) ? by : undefined,
    plants,
    direction,
    otherEntryId: other?._id || null,
    otherRequestNumber: other?.requestNumber || "",
  };
}

/**
 * Write batch figures and move slot available plants once per slot.
 * Negative moves run first so a later sowing on the same slot still gains stock.
 */
export async function applyLeftoverToSlots(updates, by) {
  const located = [];
  for (const update of updates) {
    const entry = update.entry;
    if (!entry?.sowingRequestId) continue;
    const found = await findSowBatchForRequest(entry.sowingRequestId);
    const hit = found?.[0];
    if (!hit?.batch?._id || !hit.slotId) continue;
    located.push({ ...update, slotId: String(hit.slotId), batchId: String(hit.batch._id) });
  }
  const bySlot = new Map();
  for (const row of located) {
    if (!bySlot.has(row.slotId)) bySlot.set(row.slotId, []);
    bySlot.get(row.slotId).push(row);
  }

  for (const [slotId, rows] of bySlot) {
    const plantSlot = await PlantSlot.findOne({ "subtypeSlots.slots._id": slotId });
    if (!plantSlot) continue;
    let slot = null;
    for (const subtype of plantSlot.subtypeSlots || []) {
      slot = subtype.slots.id(slotId);
      if (slot) break;
    }
    if (!slot) continue;

    const ordered = [...rows].sort((a, b) => signed(a.availableDelta) - signed(b.availableDelta));
    let available = int(slot.availablePlants);
    for (const row of ordered) {
      const batch = slot.sowingBatches.id(row.batchId);
      if (!batch) continue;
      const entry = row.entry;
      const before = int(batch.excessPlants);
      batch.plantsSowed = int(entry.plantsSowed);
      batch.sowingBufferPct = Number(entry.sowingBufferPct) || 0;
      batch.bufferPlants = int(entry.bufferPlants);
      batch.noMortalityReserve = Boolean(entry.noMortalityReserve);
      batch.excessPlants = int(entry.excessPlants);
      batch.shownExcess = int(entry.excessPlants);
      batch.plantsTransferredOut = int(entry.plantsTransferredOut);
      batch.plantsTransferredIn = int(entry.plantsTransferredIn);
      batch.plantsMarkedSellable = int(entry.plantsMarkedSellable);
      const last = (entry.transferLog || [])[entry.transferLog.length - 1];
      if (last) {
        batch.transferLog = batch.transferLog || [];
        batch.transferLog.push({
          at: last.at || new Date(),
          by: last.by,
          plants: int(last.plants),
          direction: last.direction,
          otherEntryId: last.otherEntryId || null,
          otherRequestNumber: last.otherRequestNumber || "",
        });
      }
      if (row.change) {
        batch.changeLog = batch.changeLog || [];
        batch.changeLog.push({
          at: new Date(),
          by: by && mongoose.Types.ObjectId.isValid(String(by)) ? by : undefined,
          kind: row.change.kind,
          plants: int(row.change.plants),
          excessBefore: before,
          excessAfter: int(entry.excessPlants),
          reason: row.change.reason || "",
        });
      }
      const delta = signed(row.availableDelta);
      batch.availablePlantsApplied = Math.max(0, int(batch.availablePlantsApplied) + delta);
      available = delta < 0 ? Math.max(0, available + delta) : available + delta;
    }
    applyStockFieldUpdates(
      slot,
      { availablePlants: available },
      by,
      ordered.map((row) => row.change?.reason).filter(Boolean).join(" · ") || "Leftover sowing"
    );
    await plantSlot.save({ validateBeforeSave: true });
  }
}

export async function transferRemaining(entryId, plants, by) {
  const source = await loadEntry(entryId);
  const qty = takeQuantity(source, plants);
  const next = pickNextSowing(source, await candidatesFor(source));
  if (!next) {
    throw new AppError("No later sowing of this variety", 400);
  }
  const target = await SowingEntry.findById(next._id);
  if (!target || target.isIrrelevant) throw new AppError("No later sowing of this variety", 400);

  const sourceExcessBefore = int(source.excessPlants);
  const targetExcessBefore = int(target.excessPlants);
  const sourceNext = withSowed(source, int(source.plantsSowed) - qty);
  sourceNext.plantsTransferredOut = int(source.plantsTransferredOut) + qty;
  const targetNext = withSowed(target, int(target.plantsSowed) + qty);
  targetNext.plantsTransferredIn = int(target.plantsTransferredIn) + qty;
  assignFigures(source, sourceNext);
  assignFigures(target, targetNext);
  pushLog(source, logRow({ plants: qty, direction: "out", other: target, by }));
  pushLog(target, logRow({ plants: qty, direction: "in", other: source, by }));
  await source.save();
  await target.save();
  await applyLeftoverToSlots(
    [
      {
        entry: source,
        availableDelta: -qty,
        change: {
          kind: "TRANSFER_TO_NEXT",
          plants: qty,
          excessBefore: sourceExcessBefore,
          reason: `Transferred ${qty} to ${target.requestNumber || "the next sowing"}`,
        },
      },
      {
        entry: target,
        availableDelta: qty,
        change: {
          kind: "TRANSFER_FROM_PREV",
          plants: qty,
          excessBefore: targetExcessBefore,
          reason: `Received ${qty} from ${source.requestNumber || "an earlier sowing"}`,
        },
      },
    ],
    by
  );
  const stamped = restamp(target.toObject());
  return {
    plants: qty,
    sourceId: String(source._id),
    targetId: String(target._id),
    targetRequestNumber: target.requestNumber || "",
    targetExcess: stamped.excessPlants,
    sourceRemaining: restamp(source.toObject()).remainingPlants,
  };
}

export async function markSellable(entryId, plants, by) {
  const entry = await loadEntry(entryId);
  const qty = takeQuantity(entry, plants);
  const excessBefore = int(entry.excessPlants);
  const next = withMarked(entry, qty);
  assignFigures(entry, next);
  pushLog(entry, logRow({ plants: qty, direction: "sellable", other: null, by }));
  await entry.save();
  await applyLeftoverToSlots(
    [
      {
        entry,
        availableDelta: qty,
        change: {
          kind: "MARK_SELLABLE",
          plants: qty,
          excessBefore,
          reason: `Marked ${qty} leftover plants sellable`,
        },
      },
    ],
    by
  );
  return {
    plants: qty,
    entryId: String(entry._id),
    excess: restamp(entry.toObject()).excessPlants,
    remaining: restamp(entry.toObject()).remainingPlants,
  };
}
