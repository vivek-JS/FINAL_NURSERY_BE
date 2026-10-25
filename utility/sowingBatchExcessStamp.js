import { reportedExcessBreakdown } from "./lagwadSlotPlantsSplit.js";

const pctOf = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const intQty = (v) => Math.max(0, Math.floor(Number(v) || 0));

export function excessAllocatedPlants(batch) {
  return (batch?.excessAllocations || []).reduce((s, a) => s + intQty(a?.plants), 0);
}

/**
 * Reduced original orders can lower cover; plants later taken from this batch's excess always count.
 */
export function coverQtyForExcess(covered, live = 0, allocated = 0) {
  const cover = intQty(covered);
  const take = Math.min(cover, intQty(allocated));
  const original = cover - take;
  const liveQty = intQty(live);
  const orderPart = liveQty > 0 && liveQty <= original ? liveQty : original;
  return orderPart + take;
}

/**
 * Order quantity for the excess formula. When the linked orders add up to
 * less than the saved cover, the orders were reduced and that lower total is used.
 * A larger linked total is ignored so a shared order list cannot wipe the excess.
 * Dispatch excess takes stay in cover via excessAllocations.
 */
export function displayOrderQty(batch, plantQtyByOrderId = null) {
  const covered = intQty(batch?.orderCoveredPlants);
  const allocated = excessAllocatedPlants(batch);
  const ids = batch?.linkedOrderIds || [];
  if (!plantQtyByOrderId || !ids.length) return covered;
  let live = 0;
  let known = 0;
  for (const id of ids) {
    const qty = plantQtyByOrderId.get(String(id));
    if (qty == null) continue;
    known += 1;
    live += intQty(qty);
  }
  if (!known) return covered;
  return coverQtyForExcess(covered, live, allocated);
}

/** Numbers for a sowing entry: CMS percent of sowed is mortality, then subtract the orders. */
export function displaySowingFigures({
  plantsSowed = 0,
  orderCoveredPlants = 0,
  linkedOrders = null,
  bufferPlants = null,
  sowingBufferPct = 0,
  mortalityMovedToExcess = 0,
  excessAllocated = 0,
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
  const covered = intQty(orderCoveredPlants);
  const live = (linkedOrders || []).reduce((sum, order) => sum + intQty(order?.plants), 0);
  const orders = coverQtyForExcess(covered, live, excessAllocated);
  const moved = intQty(mortalityMovedToExcess);
  return {
    bufferPlants: buffer,
    mortality: Math.max(0, buffer - moved),
    excess: Math.max(0, sowed - orders) + moved,
  };
}

/** Writes the entry numbers the sowing list shows: mortality, excess, and the movable reserve. */
export function paintSowingEntryNumbers(slot, {
  batch = null,
  linkedOrders = null,
  bufferPct = 0,
  sowed = 0,
  mortalityReserve = 0,
  /** When false, skip writing batch bookable excess (partial entry rows). */
  showBookableExcess = true,
} = {}) {
  const figures = displaySowingFigures({
    plantsSowed: sowed,
    orderCoveredPlants: batch?.orderCoveredPlants,
    linkedOrders,
    bufferPlants: batch?.bufferPlants,
    sowingBufferPct: batch?.sowingBufferPct ?? bufferPct,
    mortalityMovedToExcess: batch?.mortalityMovedToExcess,
    excessAllocated: excessAllocatedPlants(batch),
    isIrrelevant: batch?.isIrrelevant,
  });
  // Same number as dispatch "Free" — do not use entry-split linkedOrders for leftover.
  const bookable = showBookableExcess
    ? storedShownExcess(
        batch || {
          plantsSowed: sowed,
          orderCoveredPlants: figures.excess > 0 ? Math.max(0, sowed - figures.excess) : 0,
          sowingBufferPct: bufferPct,
          mortalityMovedToExcess: batch?.mortalityMovedToExcess,
          isIrrelevant: batch?.isIrrelevant,
        },
        batch?.sowingBufferPct ?? bufferPct
      )
    : 0;
  figures.excess = bookable;
  if (slot) {
    slot.bufferPlants = figures.bufferPlants;
    slot.mortalityMovedToExcess = Math.max(0, Math.floor(Number(batch?.mortalityMovedToExcess) || 0));
    slot.mortalityReserve = Math.max(0, Math.floor(Number(mortalityReserve) || 0));
    slot.batchExpectedMortality = figures.mortality;
    slot.excessPlants = bookable;
  }
  return figures;
}

/** Leftover = sowed − orders (+ mortality moved). Buffer is not subtracted again. */
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

/** Leftover after orders. Buffer is mortality only — not subtracted again. */
export function storedShownExcess(batch, sowingBufferPct = 0) {
  if (!batch || batch.isIrrelevant) return 0;
  return excessFieldsForBatch(batch, batch?.sowingBufferPct ?? sowingBufferPct).shownExcess;
}

/** Dispatch picker free = web sowing-entries excess. */
export function dispatchBookableFree(batch, sowingBufferPct = 0) {
  return storedShownExcess(batch, batch?.sowingBufferPct ?? sowingBufferPct);
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
