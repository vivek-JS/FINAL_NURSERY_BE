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

/** Mortality already shifted into the excess count. */
export function mortalityMovedPlants(batch) {
  return toInt(batch?.mortalityMovedToExcess);
}

/**
 * Mortality still shown on the sowing. This is the sow reserve minus plants
 * already moved, so a partial move leaves the rest on screen.
 */
export function mortalityLeftOnBatch(batch) {
  if (!batch || batch.isIrrelevant) return 0;
  const moved = mortalityMovedPlants(batch);
  if (batch.noMortalityReserve && moved <= 0) return 0;
  const reserve = sowBatchStock({ ...batch, isIrrelevant: false, noMortalityReserve: false }).reserve;
  return Math.max(0, reserve - moved);
}

/** Reported excess plus mortality that was moved into it. */
export function excessPlusMoved(excess, batch) {
  if (!batch || batch.isIrrelevant) return Math.max(0, toInt(excess));
  return Math.max(0, toInt(excess) + mortalityMovedPlants(batch));
}

/** Pure move of some (or all) of the mortality hold-back into saleable excess. */
export function planMortalityToExcess({ slot, batch, plants } = {}) {
  if (batch?.isIrrelevant) return { error: "Irrelevant sowing is not counted" };
  const movedAlready = mortalityMovedPlants(batch);
  if (batch?.noMortalityReserve && movedAlready <= 0) return { error: "Mortality is already in excess" };
  const explicit = plants != null && plants !== "";
  const shown = mortalityLeftOnBatch(batch);
  const mort = explicit ? toInt(plants) : mortalityHeldOnBatch(batch);
  if (mort <= 0) {
    return { error: explicit ? "Enter how many plants to move" : "This sowing has no mortality to move" };
  }
  if (explicit && shown <= 0) return { error: "This sowing has no mortality to move" };
  if (explicit && mort > shown) {
    return { error: `You can move up to ${shown.toLocaleString("en-IN")}` };
  }
  if (explicit && mort > toInt(slot?.expectedMortality)) {
    const left = toInt(slot?.expectedMortality);
    return { error: `Only ${left.toLocaleString("en-IN")} mortality is left on this slot` };
  }
  const excessive = toInt(slot?.excessiveSowing?.plants);
  const addExcessive = Boolean(batch?.isExcessiveSowing) || toInt(batch?.orderCoveredPlants) <= 0;
  return {
    mort,
    releaseAll: explicit ? mort >= shown : true,
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

/** POST body: move some or all of this batch's mortality hold-back into excess. */
export async function releaseBatchMortalityToExcess({ slotId, batchId, plants, performedBy }) {
  if (!mongoose.isValidObjectId(String(slotId))) throw new AppError("Invalid slot id", 400);
  if (!mongoose.isValidObjectId(String(batchId))) throw new AppError("Invalid batch id", 400);
  const by = performedBy && mongoose.isValidObjectId(String(performedBy)) ? performedBy : undefined;

  const plantSlot = await PlantSlot.findOne({ "subtypeSlots.slots._id": slotId });
  const slot = findSlot(plantSlot, slotId);
  if (!slot) throw new AppError("Slot not found", 404);
  const batch = slot.sowingBatches.id(batchId);
  if (!batch) throw new AppError("Sowing batch not found on this slot", 404);

  const plan = planMortalityToExcess({ slot, batch, plants });
  if (plan.error) throw new AppError(plan.error, 400);

  const explicit = plants != null && plants !== "";
  if (explicit) {
    batch.mortalityMovedToExcess = toInt(batch.mortalityMovedToExcess) + plan.mort;
    batch.noMortalityReserve = mortalityLeftOnBatch(batch) <= 0;
    batch.expectedMortalityApplied = batch.noMortalityReserve
      ? 0
      : Math.max(0, toInt(batch.expectedMortalityApplied) - plan.mort);
  } else {
    batch.noMortalityReserve = true;
    batch.expectedMortalityApplied = 0;
  }
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
    mortalityLeft: mortalityLeftOnBatch(batch),
    availablePlants: toInt(slot.availablePlants),
    expectedMortality: toInt(slot.expectedMortality),
    noMortalityReserve: Boolean(batch.noMortalityReserve),
  };
}
