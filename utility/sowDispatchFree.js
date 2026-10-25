import { sowBatchStock } from "./lagwadSlotPlantsSplit.js";

const toQty = (v) => Math.max(0, Math.floor(Number(v) || 0));

/** Free stock the dispatch planner may physically load; unreleased mortality reserve is not loadable. */
export function dispatchLoadableFree(batch) {
  if (batch?.isIrrelevant) return 0;
  const sowed = Math.max(0, toQty(batch?.plantsSowed) - toQty(batch?.destroyedPlants));
  const covered = toQty(batch?.orderCoveredPlants);
  const storedReserve = batch?.expectedMortalityApplied;
  const reserve = batch?.noMortalityReserve
    ? 0
    : storedReserve != null && storedReserve !== ""
      ? toQty(storedReserve)
      : sowBatchStock(batch, batch?.sowingBufferPct).reserve;
  return Math.max(0, sowed - covered - reserve);
}
