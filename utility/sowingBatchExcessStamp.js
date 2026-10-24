import { reportedExcessBreakdown } from "./lagwadSlotPlantsSplit.js";

const pctOf = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** CMS percent off plants sowed, then orders. Mortality already moved is included. */
export function excessFieldsForBatch(batch, sowingBufferPct = 0) {
  const pct = pctOf(sowingBufferPct);
  if (!batch || batch.isIrrelevant) {
    return { sowingBufferPct: pct, bufferPlants: 0, shownExcess: 0 };
  }
  const parts = reportedExcessBreakdown({
    plantsSowed: batch.plantsSowed,
    orderCoveredPlants: batch.orderCoveredPlants,
    sowingBufferPct: pct,
  });
  const moved = Math.max(0, Math.floor(Number(batch.mortalityMovedToExcess) || 0));
  return {
    sowingBufferPct: pct,
    bufferPlants: parts.bufferPlants,
    shownExcess: parts.excess + moved,
  };
}

export function applyExcessFields(batch, sowingBufferPct = 0) {
  if (!batch) return batch;
  Object.assign(batch, excessFieldsForBatch(batch, sowingBufferPct));
  return batch;
}

/** Stored shownExcess when the batch has been stamped. Otherwise the same formula. */
export function storedShownExcess(batch, sowingBufferPct = 0) {
  if (!batch || batch.isIrrelevant) return 0;
  if (batch.shownExcess != null && batch.sowingBufferPct != null) {
    return Math.max(0, Math.floor(Number(batch.shownExcess) || 0));
  }
  return excessFieldsForBatch(batch, sowingBufferPct).shownExcess;
}

export function stampSlotDocument(plantSlot, sowingBufferPct = 0) {
  for (const subtype of plantSlot?.subtypeSlots || []) {
    for (const slot of subtype?.slots || []) {
      for (const batch of slot?.sowingBatches || []) {
        applyExcessFields(batch, sowingBufferPct);
      }
    }
  }
  return plantSlot;
}
