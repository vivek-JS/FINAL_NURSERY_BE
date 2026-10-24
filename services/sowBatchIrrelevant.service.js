import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import AppError from "../utility/appError.js";
import { applyStockFieldUpdates } from "../utility/slotStockTrail.js";
import { sowBatchStock, sowQtySlotImpact } from "../utility/lagwadSlotPlantsSplit.js";
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
 * Plants this batch currently contributes to slot.availablePlants.
 * availablePlantsApplied is that balance after later excess allocations.
 */
export function batchSaleableStock(batch) {
  const applied = batch?.availablePlantsApplied;
  if (applied != null && applied !== "") return toInt(applied);
  const live = sowBatchStock({ ...plainBatch(batch), isIrrelevant: false });
  return sowQtySlotImpact(live.free, { isExcess: true }).availablePlants;
}

/** Pure mark/unmark of slot available + excessive plants. Does not touch order cover. */
export function planIrrelevantStockPull({ slot, batch, mark }) {
  const avail = toInt(slot?.availablePlants);
  const excessive = toInt(slot?.excessiveSowing?.plants);
  if (mark) {
    if (batch?.isIrrelevant) return { error: "Sowing batch is already irrelevant" };
    const pulled = Math.min(batchSaleableStock(batch), avail);
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

  const plan = planIrrelevantStockPull({ slot, batch, mark });
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

  return {
    slotId: idStr(slotId),
    batchId: idStr(batchId),
    isIrrelevant: Boolean(batch.isIrrelevant),
    availablePlants: toInt(slot.availablePlants),
    excessivePlants: toInt(slot.excessiveSowing?.plants),
    stockPulled: plan.isIrrelevant ? plan.pulled : plan.restored,
  };
}
