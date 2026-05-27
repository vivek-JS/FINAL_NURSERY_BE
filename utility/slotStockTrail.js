export const STOCK_TRAIL_ACTIONS = {
  actualPlants: "ACTUAL_PLANTS_UPDATED",
  closingStock: "CLOSING_STOCK_UPDATED",
  availablePlants: "AVAILABLE_PLANTS_UPDATED",
};

export const STOCK_TRAIL_ACTION_LIST = Object.values(STOCK_TRAIL_ACTIONS);

const buildSnapshot = (slot, field, fieldValue) => {
  const totalPlants = Number(slot.totalPlants) || 0;
  const availablePlants =
    slot.availablePlants !== undefined && slot.availablePlants !== null
      ? Number(slot.availablePlants)
      : totalPlants;

  return {
    primarySowed: Number(slot.primarySowed) || 0,
    officeSowed: Number(slot.officeSowed) || 0,
    totalPlants,
    availablePlants:
      field === "availablePlants" ? fieldValue : availablePlants,
    excessivePlants: Number(slot.excessiveSowing?.plants) || 0,
    plantsSowed: Number(slot.plantsSowed) || 0,
    totalBookedPlants: Number(slot.totalBookedPlants) || 0,
    inProgressCount: Array.isArray(slot.sowingInProgress)
      ? slot.sowingInProgress.length
      : 0,
    actualPlants:
      field === "actualPlants"
        ? fieldValue
        : Number(slot.actualPlants) || 0,
    closingStock:
      field === "closingStock"
        ? fieldValue
        : Number(slot.closingStock) || 0,
  };
};

/**
 * Append one slotTrail entry for a single stock field change.
 */
export function logStockFieldChange(
  slot,
  field,
  previousValue,
  newValue,
  performedBy,
  source = "Slot update"
) {
  if (!slot || !STOCK_TRAIL_ACTIONS[field]) return false;

  const prev = Math.max(0, Number(previousValue) || 0);
  const next = Math.max(0, Number(newValue) || 0);
  if (prev === next) return false;

  const action = STOCK_TRAIL_ACTIONS[field];
  const activityNameByField = {
    actualPlants: "Actual Plants Updated",
    closingStock: "Closing Stock Updated",
    availablePlants: "Available Plants Updated",
  };
  const activityName = activityNameByField[field] || "Stock Updated";
  const totalPlants = Number(slot.totalPlants) || 0;
  const availablePlants =
    slot.availablePlants !== undefined && slot.availablePlants !== null
      ? Number(slot.availablePlants)
      : totalPlants;

  const before = buildSnapshot(slot, field, prev);
  const after = buildSnapshot(slot, field, next);

  const trailEntry = {
    action,
    activityName,
    quantity: Math.abs(next - prev),
    plus: {
      primarySowed: 0,
      officeSowed: 0,
      totalPlants: 0,
      availablePlants: 0,
      excessivePlants: 0,
      packetsUsed: 0,
      plantsSowed: 0,
      gapCovered: 0,
    },
    minus: {
      packetsRemaining: 0,
      inProgressEntries: 0,
    },
    before,
    after,
    previousTotalPlants: totalPlants,
    newTotalPlants: totalPlants,
    previousAvailablePlants: field === "availablePlants" ? prev : availablePlants,
    newAvailablePlants: field === "availablePlants" ? next : availablePlants,
    bufferPercentage: Number(slot.effectiveBuffer ?? slot.buffer) || 0,
    bufferAmount: Number(slot.bufferAmount) || 0,
    reason: source,
    performedBy: performedBy || null,
    notes: `${prev} → ${next}`,
    metadata: {
      stockField: field,
      previousValue: prev,
      newValue: next,
    },
  };

  if (!slot.slotTrail) {
    slot.slotTrail = [];
  }
  slot.slotTrail.unshift(trailEntry);
  if (slot.slotTrail.length > 1000) {
    slot.slotTrail = slot.slotTrail.slice(0, 1000);
  }

  return true;
}

/**
 * Apply actualPlants / closingStock updates and log each changed field.
 */
export function applyStockFieldUpdates(slot, updates, performedBy, source) {
  let changed = false;
  for (const field of ["actualPlants", "closingStock", "availablePlants"]) {
    if (updates[field] === undefined) continue;
    const prev = Number(slot[field]) || 0;
    const next = Math.max(0, Number(updates[field]) || 0);
    if (logStockFieldChange(slot, field, prev, next, performedBy, source)) {
      changed = true;
    }
    slot[field] = next;
    if (field === "availablePlants") {
      slot.isOverflow = next < 0;
      slot.overflow = next < 0;
    }
  }
  return changed;
}
