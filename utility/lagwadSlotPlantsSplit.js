/** Lagwad → slot: 90% actual plants, 10% expected mortality (all lagwad paths). */
export const LAGWAD_ACTUAL_PLANTS_PCT = 90;

export function clampMortalityPct(value, fallback = 10) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(50, n);
}

export function splitLagwadQtyForSlot(qty, mortalityPct = 10) {
  const total = Math.max(0, Math.floor(Number(qty) || 0));
  if (total < 1) {
    return { total: 0, actualPlants: 0, expectedMortality: 0 };
  }
  const mort = clampMortalityPct(mortalityPct, 10);
  const actualPct = 100 - mort;
  const actualPlants = Math.floor((total * actualPct) / 100);
  const expectedMortality = total - actualPlants;
  return { total, actualPlants, expectedMortality };
}

/** Extra sown for orders is kept as mortality buffer up to this share of the order plants. */
export const ORDER_MORTALITY_BUFFER_PCT = 20;

const toQty = (v) => Math.max(0, Math.floor(Number(v) || 0));

/**
 * Expected mortality of one sowing: at least 10% of sowed; when it covered orders,
 * the leftover is kept as buffer up to 20% of the order plants.
 * 12,000 sowed for 10,000 ordered → 2,000; 15,000 for 10,000 → 2,000; 12,000 with no orders → 1,200.
 */
export function sowMortalityReserve(plantsSowed, orderCoveredPlants = 0, mortalityPct = 10) {
  const sowed = toQty(plantsSowed);
  const covered = Math.min(sowed, toQty(orderCoveredPlants));
  const buffer = Math.min(sowed - covered, Math.floor((covered * ORDER_MORTALITY_BUFFER_PCT) / 100));
  return Math.max(splitLagwadQtyForSlot(sowed, mortalityPct).expectedMortality, buffer);
}

/**
 * One slot sowing batch: mortality reserve and plants free to sell.
 * batch.noMortalityReserve = sowed count is confirmed, so nothing is held back.
 */
export function sowBatchStock(batch) {
  const sowed = Math.max(0, toQty(batch?.plantsSowed) - toQty(batch?.destroyedPlants));
  const covered = toQty(batch?.orderCoveredPlants);
  const takenFromExcess = (batch?.excessAllocations || []).reduce((s, a) => s + toQty(a?.plants), 0);
  const reserve = batch?.noMortalityReserve
    ? 0
    : Math.min(sowed, sowMortalityReserve(sowed, Math.max(0, covered - takenFromExcess)));
  return { sowed, covered, reserve, free: Math.max(0, sowed - reserve - covered) };
}

/**
 * Sellable sow stock on a slot (capacity board, booking, excess cover).
 * Orders keep all their plants; each batch's mortality reserve is never offered for booking.
 */
export function slotSowStock(slot) {
  const primarySowed = toQty(slot?.primarySowed);
  let batchSowed = 0;
  let gross = 0;
  let reserve = 0;
  let free = 0;
  for (const batch of slot?.sowingBatches || []) {
    const b = sowBatchStock(batch);
    batchSowed += b.sowed;
    gross += b.covered;
    reserve += b.reserve;
    free += b.free;
  }
  const untracked = splitLagwadQtyForSlot(Math.max(0, primarySowed - batchSowed));
  reserve += untracked.expectedMortality;
  free = Math.min(free + untracked.actualPlants, Math.max(0, primarySowed - gross));
  const expectedMortality = Math.min(reserve, primarySowed);
  return {
    actualPlants: primarySowed - expectedMortality,
    expectedMortality,
    free,
  };
}

/** Max slot-synced position for a lagwad line (90% of physical avail). */
export function maxLagwadSyncedPlants(availableQuantity) {
  return splitLagwadQtyForSlot(availableQuantity).actualPlants;
}

export function computeLagwadPendingSlotSync(availableQuantity, slotStockSyncedPlants) {
  const split = splitLagwadQtyForSlot(availableQuantity);
  const synced = Math.max(0, Math.floor(Number(slotStockSyncedPlants) || 0));
  const pending = Math.max(0, split.actualPlants - synced);
  return {
    pending,
    actualPlantsDelta: pending,
    expectedMortalityDelta: split.expectedMortality,
    readyDelta: pending,
    lagwadRemainingDelta: 0,
    syncedAfter: synced + pending,
    maxSynced: split.actualPlants,
  };
}

/**
 * Complete-sow / order mark-sow / edit-sow. plantsSowed stays gross; mortality is sowMortalityReserve
 * (10% floor, up to 20% of order plants as buffer). Orders are reserved first, the rest is saleable.
 */
export function sowQtySlotImpact(
  plantsSowed,
  { isExcess = false, excessPlants = 0, orderCoveredPlants = 0, mortalityPct = 10 } = {}
) {
  const total = toQty(plantsSowed);
  const excessQty = isExcess ? total : toQty(excessPlants);
  const coveredQty = isExcess ? 0 : toQty(orderCoveredPlants);
  const expectedMortality = sowMortalityReserve(total, coveredQty, mortalityPct);
  const actualPlants = total - expectedMortality;
  const orderReservedPlants = Math.min(coveredQty, actualPlants);
  return {
    plantsSowed: total,
    actualPlants,
    expectedMortality,
    availablePlants: Math.min(excessQty, actualPlants - orderReservedPlants),
    orderReservedPlants,
    excessPlants: excessQty,
    orderCoveredPlants: coveredQty,
  };
}
