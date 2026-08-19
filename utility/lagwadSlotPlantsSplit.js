/** Lagwad → slot: 90% actual plants, 10% expected mortality (all lagwad paths). */
export const LAGWAD_ACTUAL_PLANTS_PCT = 90;

export function splitLagwadQtyForSlot(qty) {
  const total = Math.max(0, Math.floor(Number(qty) || 0));
  if (total < 1) {
    return { total: 0, actualPlants: 0, expectedMortality: 0 };
  }
  const actualPlants = Math.floor((total * LAGWAD_ACTUAL_PLANTS_PCT) / 100);
  const expectedMortality = total - actualPlants;
  return { total, actualPlants, expectedMortality };
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
 * Complete-sow / order mark-sow / edit-sow: same 90/10 as diary.
 * plantsSowed stays gross; actual / mortality / saleable / reserved use 90%.
 */
export function sowQtySlotImpact(
  plantsSowed,
  { isExcess = false, excessPlants = 0, orderCoveredPlants = 0 } = {}
) {
  const gross = splitLagwadQtyForSlot(plantsSowed);
  const excessQty = isExcess
    ? gross.total
    : Math.max(0, Math.floor(Number(excessPlants) || 0));
  const coveredQty = isExcess
    ? 0
    : Math.max(0, Math.floor(Number(orderCoveredPlants) || 0));
  const excess = splitLagwadQtyForSlot(excessQty);
  const covered = splitLagwadQtyForSlot(coveredQty);
  return {
    plantsSowed: gross.total,
    actualPlants: gross.actualPlants,
    expectedMortality: gross.expectedMortality,
    availablePlants: excess.actualPlants,
    orderReservedPlants: covered.actualPlants,
    excessPlants: excess.total,
    orderCoveredPlants: covered.total,
  };
}
