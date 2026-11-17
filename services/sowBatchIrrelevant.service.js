import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import SowingEntry from "../models/sowingEntry.model.js";
import AppError from "../utility/appError.js";
import { applyStockFieldUpdates } from "../utility/slotStockTrail.js";
import { sowBatchStock, sowQtySlotImpact } from "../utility/lagwadSlotPlantsSplit.js";
import { excessFieldsForBatch } from "../utility/sowingBatchExcessStamp.js";
import { dmyToYmd } from "./sowBatchStock.service.js";

const toInt = (v) => Math.max(0, Math.floor(Number(v) || 0));
const idStr = (v) => (v == null || v === "" ? "" : String(v));

function plainBatch(batch) {
  if (batch && typeof batch.toObject === "function") return batch.toObject();
  return batch;
}

export const WATERMELON_IRRELEVANT_BEFORE = "2026-10-14";

export function isSuperAdminUser(user) {
  const job = String(user?.jobTitle || "").toUpperCase();
  const role = String(user?.role || "").toUpperCase();
  return job === "SUPER_ADMIN" || job === "SUPERADMIN" || role === "SUPER_ADMIN" || role === "SUPERADMIN";
}

export function isWatermelonPlantName(name) {
  return /water|tarbuj/i.test(String(name || ""));
}

/** plantReadyDate is DD-MM-YYYY. True when it is strictly before the cutoff day. */
export function readyBeforeYmd(dmy, cutoffYmd = WATERMELON_IRRELEVANT_BEFORE) {
  const ymd = dmyToYmd(dmy);
  return Boolean(ymd) && ymd < cutoffYmd;
}

/**
 * Plants still sitting after Out (dispatched). Ready = sowed − mortality buffer.
 * Prefer entry buffer/out when the slot batch stamp is stale or dispatchLog is empty.
 */
export function remainingAfterOut(batch, { outPlants, bufferPlants } = {}) {
  const sowed = Math.max(0, toInt(batch?.plantsSowed) - toInt(batch?.destroyedPlants));
  const buffer =
    bufferPlants != null && bufferPlants !== ""
      ? toInt(bufferPlants)
      : batch?.bufferPlants != null && batch.bufferPlants !== ""
        ? toInt(batch.bufferPlants)
        : toInt(batch?.expectedMortalityApplied);
  const out = outPlants != null && outPlants !== "" ? toInt(outPlants) : 0;
  return Math.max(0, sowed - buffer - out);
}

/**
 * Plants this batch currently contributes to slot.availablePlants.
 * availablePlantsApplied is that balance after later excess allocations.
 * Cap by remaining after Out so already-given plants are not pulled again.
 */
export function batchSaleableStock(batch, opts = {}) {
  const applied = batch?.availablePlantsApplied;
  let stock =
    applied != null && applied !== ""
      ? toInt(applied)
      : sowQtySlotImpact(sowBatchStock({ ...plainBatch(batch), isIrrelevant: false }).free, {
          isExcess: true,
        }).availablePlants;
  if (opts.outPlants != null || opts.bufferPlants != null) {
    stock = Math.min(stock, remainingAfterOut(batch, opts));
  }
  return stock;
}

/** Pure mark/unmark of slot available + excessive plants. Does not touch order cover. */
export function planIrrelevantStockPull({ slot, batch, mark, outPlants, bufferPlants }) {
  const avail = toInt(slot?.availablePlants);
  const excessive = toInt(slot?.excessiveSowing?.plants);
  if (mark) {
    if (batch?.isIrrelevant) return { error: "Sowing batch is already irrelevant" };
    const pulled = Math.min(batchSaleableStock(batch, { outPlants, bufferPlants }), avail);
    return {
      isIrrelevant: true,
      pulled,
      availablePlants: avail - pulled,
      excessivePlants: Math.max(0, excessive - pulled),
    };
  }
  if (!batch?.isIrrelevant) return { error: "Sowing batch is already relevant" };
  const restore = toInt(batch?.irrelevantStockPulled);
  return {
    isIrrelevant: false,
    pulled: 0,
    restored: restore,
    availablePlants: avail + restore,
    excessivePlants: excessive + restore,
  };
}

function findSlot(plantSlot, slotId) {
  for (const st of plantSlot?.subtypeSlots || []) {
    const slot = st.slots.id(slotId);
    if (slot) return slot;
  }
  return null;
}

/** POST body: mark or clear isIrrelevant and pull/restore bookable excess on the slot. */
export async function setSowBatchIrrelevant({ slotId, batchId, isIrrelevant, performedBy }) {
  if (!mongoose.isValidObjectId(String(slotId))) throw new AppError("Invalid slot id", 400);
  if (!mongoose.isValidObjectId(String(batchId))) throw new AppError("Invalid batch id", 400);
  const by = performedBy && mongoose.isValidObjectId(String(performedBy)) ? performedBy : undefined;
  const mark = Boolean(isIrrelevant);

  const plantSlot = await PlantSlot.findOne({ "subtypeSlots.slots._id": slotId });
  const slot = findSlot(plantSlot, slotId);
  if (!slot) throw new AppError("Slot not found", 404);
  const batch = slot.sowingBatches.id(batchId);
  if (!batch) throw new AppError("Sowing batch not found on this slot", 404);

  const entry = await SowingEntry.findOne({ sourceBatchId: batch._id })
    .select("dispatchedPlants bufferPlants isIrrelevant excessPlants sowingBufferPct plantsSowed")
    .lean();
  const plan = planIrrelevantStockPull({
    slot,
    batch,
    mark,
    outPlants: entry?.dispatchedPlants,
    bufferPlants: entry?.bufferPlants ?? batch.bufferPlants,
  });
  if (plan.error) throw new AppError(plan.error, 400);

  batch.isIrrelevant = plan.isIrrelevant;
  batch.irrelevantStockPulled = plan.pulled;
  batch.irrelevantAt = plan.isIrrelevant ? new Date() : null;
  batch.irrelevantBy = plan.isIrrelevant ? by || null : null;
  if (slot.excessiveSowing) slot.excessiveSowing.plants = plan.excessivePlants;

  const label = batch.requestNumber || "sowing batch";
  const verb = plan.isIrrelevant ? "irrelevant" : "relevant";
  applyStockFieldUpdates(
    slot,
    { availablePlants: plan.availablePlants },
    by,
    `Sowing marked ${verb} · ${label}`
  );
  if (by) slot.setPerformer?.(by);
  await plantSlot.save({ validateBeforeSave: true });

  const entryDoc = await SowingEntry.findOne({ sourceBatchId: batch._id }).lean();
  if (entryDoc) {
    const excess = plan.isIrrelevant
      ? 0
      : excessFieldsForBatch(entryDoc, entryDoc.sowingBufferPct || 0).shownExcess;
    await SowingEntry.updateOne(
      { _id: entryDoc._id },
      { $set: { isIrrelevant: plan.isIrrelevant, excessPlants: excess } }
    );
  }

  return {
    slotId: idStr(slotId),
    batchId: idStr(batchId),
    isIrrelevant: Boolean(batch.isIrrelevant),
    availablePlants: toInt(slot.availablePlants),
    excessivePlants: toInt(slot.excessiveSowing?.plants),
    stockPulled: plan.isIrrelevant ? plan.pulled : plan.restored,
    remainingAfterOut: remainingAfterOut(batch, {
      outPlants: entry?.dispatchedPlants,
      bufferPlants: entry?.bufferPlants ?? batch.bufferPlants,
    }),
  };
}
