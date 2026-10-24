import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import AppError from "../utility/appError.js";
import { applyStockFieldUpdates } from "../utility/slotStockTrail.js";
import { sowBatchStock } from "../utility/lagwadSlotPlantsSplit.js";

const toInt = (v) => Math.max(0, Math.floor(Number(v) || 0));
const idStr = (v) => (v == null || v === "" ? "" : String(v));

/**
 * Plants currently held as mortality on this batch.
 * Prefer the amount written onto the slot at sow time.
 */
export function mortalityHeldOnBatch(batch) {
  if (!batch || batch.isIrrelevant || batch.noMortalityReserve) return 0;
  const stored = toInt(batch.expectedMortalityApplied);
  if (stored > 0) return stored;
  return sowBatchStock({ ...batch, isIrrelevant: false, noMortalityReserve: false }).reserve;
}

/** Pure move of the mortality hold-back into saleable excess. */
export function planMortalityToExcess({ slot, batch }) {
  if (batch?.isIrrelevant) return { error: "Irrelevant sowing is not counted" };
  if (batch?.noMortalityReserve) return { error: "Mortality is already in excess" };
  const mort = mortalityHeldOnBatch(batch);
  if (mort <= 0) return { error: "This sowing has no mortality to move" };
  const excessive = toInt(slot?.excessiveSowing?.plants);
  const addExcessive = Boolean(batch?.isExcessiveSowing) || toInt(batch?.orderCoveredPlants) <= 0;
  return {
    mort,
    actualPlants: toInt(slot?.actualPlants) + mort,
    expectedMortality: Math.max(0, toInt(slot?.expectedMortality) - mort),
    availablePlants: toInt(slot?.availablePlants) + mort,
    excessivePlants: excessive + (addExcessive ? mort : 0),
    addExcessive,
  };
}

function findSlot(plantSlot, slotId) {
  for (const st of plantSlot?.subtypeSlots || []) {
    const slot = st.slots.id(slotId);
    if (slot) return slot;
  }
  return null;
}

/** POST body: move this batch's mortality hold-back into excess. */
export async function releaseBatchMortalityToExcess({ slotId, batchId, performedBy }) {
  if (!mongoose.isValidObjectId(String(slotId))) throw new AppError("Invalid slot id", 400);
  if (!mongoose.isValidObjectId(String(batchId))) throw new AppError("Invalid batch id", 400);
  const by = performedBy && mongoose.isValidObjectId(String(performedBy)) ? performedBy : undefined;

  const plantSlot = await PlantSlot.findOne({ "subtypeSlots.slots._id": slotId });
  const slot = findSlot(plantSlot, slotId);
  if (!slot) throw new AppError("Slot not found", 404);
  const batch = slot.sowingBatches.id(batchId);
  if (!batch) throw new AppError("Sowing batch not found on this slot", 404);

  const plan = planMortalityToExcess({ slot, batch });
  if (plan.error) throw new AppError(plan.error, 400);

  batch.noMortalityReserve = true;
  batch.expectedMortalityApplied = 0;
  batch.actualPlantsApplied = toInt(batch.actualPlantsApplied) + plan.mort;
  batch.availablePlantsApplied = toInt(batch.availablePlantsApplied) + plan.mort;
  if (plan.addExcessive && slot.excessiveSowing) {
    slot.excessiveSowing.plants = plan.excessivePlants;
  }

  const label = batch.requestNumber || "sowing batch";
  applyStockFieldUpdates(
    slot,
    {
      actualPlants: plan.actualPlants,
      expectedMortality: plan.expectedMortality,
      availablePlants: plan.availablePlants,
    },
    by,
    `Mortality moved to excess · ${label} · ${plan.mort}`
  );
  if (by) slot.setPerformer?.(by);
  await plantSlot.save({ validateBeforeSave: true });

  return {
    slotId: idStr(slotId),
    batchId: idStr(batchId),
    mortalityReleased: plan.mort,
    availablePlants: toInt(slot.availablePlants),
    expectedMortality: toInt(slot.expectedMortality),
    noMortalityReserve: true,
  };
}
