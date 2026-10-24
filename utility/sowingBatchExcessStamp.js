import { reportedExcessBreakdown } from "./lagwadSlotPlantsSplit.js";

const pctOf = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Order quantity for the excess formula. When the linked orders add up to
 * less than the saved cover, the orders were reduced and that lower total is used.
 * A larger linked total is ignored so a shared order list cannot wipe the excess.
 */
export function displayOrderQty(batch, plantQtyByOrderId = null) {
  const covered = Math.max(0, Math.floor(Number(batch?.orderCoveredPlants) || 0));
  const ids = batch?.linkedOrderIds || [];
  if (!plantQtyByOrderId || !ids.length) return covered;
  let live = 0;
  let known = 0;
  for (const id of ids) {
    const qty = plantQtyByOrderId.get(String(id));
    if (qty == null) continue;
    known += 1;
    live += Math.max(0, Math.floor(Number(qty) || 0));
  }
  if (known > 0 && live > 0 && live <= covered) return live;
  return covered;
}

/** Numbers for a sowing entry: CMS percent of sowed is mortality, then subtract the orders. */
export function displaySowingFigures({
  plantsSowed = 0,
  orderCoveredPlants = 0,
  linkedOrders = null,
  bufferPlants = null,
  sowingBufferPct = 0,
  mortalityMovedToExcess = 0,
  isIrrelevant = false,
} = {}) {
  if (isIrrelevant) return { bufferPlants: 0, mortality: 0, excess: 0 };
  const sowed = Math.max(0, Math.floor(Number(plantsSowed) || 0));
  const pctRaw = Number(sowingBufferPct);
  const pct = Number.isFinite(pctRaw) && pctRaw > 0 ? pctRaw : 0;
  const buffer =
    bufferPlants == null
      ? Math.round((sowed * pct) / 100)
      : Math.max(0, Math.round(Number(bufferPlants) || 0));
  const covered = Math.max(0, Math.floor(Number(orderCoveredPlants) || 0));
  const live = (linkedOrders || []).reduce(
    (sum, order) => sum + Math.max(0, Math.floor(Number(order?.plants) || 0)),
    0
  );
  const orders = live > 0 && live <= covered ? live : covered;
  const moved = Math.max(0, Math.floor(Number(mortalityMovedToExcess) || 0));
  return {
    bufferPlants: buffer,
    mortality: Math.max(0, buffer - moved),
    excess: Math.max(0, sowed - buffer - orders) + moved,
  };
}

/** Writes the entry numbers the sowing list shows: mortality, excess, and the movable reserve. */
export function paintSowingEntryNumbers(slot, {
  batch = null,
  linkedOrders = null,
  bufferPct = 0,
  sowed = 0,
  mortalityReserve = 0,
} = {}) {
  const figures = displaySowingFigures({
    plantsSowed: sowed,
    orderCoveredPlants: batch?.orderCoveredPlants,
    linkedOrders,
    bufferPlants: batch?.bufferPlants,
    sowingBufferPct: batch?.sowingBufferPct ?? bufferPct,
    mortalityMovedToExcess: batch?.mortalityMovedToExcess,
    isIrrelevant: batch?.isIrrelevant,
  });
  if (slot) {
    slot.bufferPlants = figures.bufferPlants;
    slot.mortalityMovedToExcess = Math.max(0, Math.floor(Number(batch?.mortalityMovedToExcess) || 0));
    slot.mortalityReserve = Math.max(0, Math.floor(Number(mortalityReserve) || 0));
    slot.batchExpectedMortality = figures.mortality;
    slot.excessPlants = figures.excess;
  }
  return figures;
}

/** CMS percent off plants sowed, then orders. Mortality already moved is included. */
export function excessFieldsForBatch(batch, sowingBufferPct = 0, plantQtyByOrderId = null) {
  const pct = pctOf(sowingBufferPct);
  if (!batch || batch.isIrrelevant) {
    return { sowingBufferPct: pct, bufferPlants: 0, shownExcess: 0 };
  }
  const parts = reportedExcessBreakdown({
    plantsSowed: batch.plantsSowed,
    orderCoveredPlants: displayOrderQty(batch, plantQtyByOrderId),
    sowingBufferPct: pct,
  });
  const moved = Math.max(0, Math.floor(Number(batch.mortalityMovedToExcess) || 0));
  return {
    sowingBufferPct: pct,
    bufferPlants: parts.bufferPlants,
    shownExcess: parts.excess + moved,
  };
}

export function applyExcessFields(batch, sowingBufferPct = 0, plantQtyByOrderId = null) {
  if (!batch) return batch;
  Object.assign(batch, excessFieldsForBatch(batch, sowingBufferPct, plantQtyByOrderId));
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

export function stampSlotDocument(plantSlot, sowingBufferPct = 0, plantQtyByOrderId = null) {
  for (const subtype of plantSlot?.subtypeSlots || []) {
    for (const slot of subtype?.slots || []) {
      for (const batch of slot?.sowingBatches || []) {
        applyExcessFields(batch, sowingBufferPct, plantQtyByOrderId);
      }
    }
  }
  return plantSlot;
}
