/**
 * Calculate effective buffer percentage using cascading logic:
 * 1. Slot Buffer (highest priority)
 * 2. Plant Subtype Buffer (medium priority) 
 * 3. Plant Buffer (lowest priority)
 */
export const calculateEffectiveBuffer = (slotBuffer, subtypeBuffer, plantBuffer) => {
  if (slotBuffer !== undefined && slotBuffer !== null && slotBuffer > 0) {
    return slotBuffer;
  }
  if (subtypeBuffer !== undefined && subtypeBuffer !== null && subtypeBuffer > 0) {
    return subtypeBuffer;
  }
  if (plantBuffer !== undefined && plantBuffer !== null && plantBuffer > 0) {
    return plantBuffer;
  }
  return 0;
};

export const calculateAvailablePlants = (totalPlants, bufferPercentage) => {
  const bufferAmount = (totalPlants * bufferPercentage) / 100;
  return Math.max(0, totalPlants - bufferAmount);
};

export const calculateBufferAdjustedCapacity = (totalPlants, totalBookedPlants, bufferPercentage) => {
  const total = Number(totalPlants) || 0;
  const booked = Number(totalBookedPlants) || 0;
  const pct = Number(bufferPercentage) || 0;
  const bufferAmount = (total * pct) / 100;
  const bufferAdjustedCapacity = total - bufferAmount;
  return {
    availablePlants: total - booked - bufferAmount,
    totalCapacity: total,
    bufferAdjustedCapacity: bufferAdjustedCapacity,
    bufferAmount: bufferAmount,
  };
};

const finiteNumber = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Capacity is always available + booked — never drives available. */
export const deriveSlotCapacity = (availablePlants, bookedPlants) => {
  const available = Number(availablePlants) || 0;
  const booked = Number(bookedPlants) || 0;
  return Math.max(0, available) + Math.max(0, booked);
};

export const isSlotBufferMaterialized = (slot) => {
  const original = finiteNumber(slot?.originalTotalPlants);
  if (original != null && original > 0) return true;
  const storedBuffer = finiteNumber(slot?.bufferAmount);
  if (storedBuffer != null && storedBuffer > 0) return true;
  const slotPct = finiteNumber(slot?.buffer);
  if (slotPct != null && slotPct > 0) return true;
  return false;
};

export const isAvailablePlantsMaterialized = (slot) => {
  if (slot?.availablePlantsMaterialized === true) return true;
  if (slot?.availablePlantsMaterialized === false) return false;
  if (Array.isArray(slot?.slotTrail)) {
    return slot.slotTrail.some((t) => t?.action === "AVAILABLE_PLANTS_UPDATED");
  }
  return false;
};

const resolveStoredAvailable = (slot, booked) => {
  const storedAvailableRaw = finiteNumber(slot?.availablePlants);
  if (isAvailablePlantsMaterialized(slot)) {
    return storedAvailableRaw ?? 0;
  }
  if (storedAvailableRaw != null && storedAvailableRaw < 0) {
    return storedAvailableRaw;
  }
  if (storedAvailableRaw != null && storedAvailableRaw > 0) {
    return storedAvailableRaw;
  }
  return computeLegacyAvailableFromCapacity(slot, booked);
};

/** One-time legacy read/migration: old totalPlants − booked − buffer (unmaterialized slots only). */
export const computeLegacyAvailableFromCapacity = (slot, bookedOverride) => {
  const booked = Number(bookedOverride ?? slot?.totalBookedPlants) || 0;
  const legacyTotal = Number(slot?.originalTotalPlants ?? slot?.totalPlants) || 0;
  if (legacyTotal <= 0) {
    const stored = finiteNumber(slot?.availablePlants);
    return stored ?? 0;
  }
  const storedBuffer = finiteNumber(slot?.bufferAmount);
  const bufferAmt =
    storedBuffer != null && storedBuffer > 0
      ? storedBuffer
      : Math.round((legacyTotal * (Number(slot?.effectiveBuffer ?? slot?.buffer) || 0)) / 100);
  return Math.max(0, legacyTotal - booked - bufferAmt);
};

/**
 * Resolve buffer + available for API/UI.
 * - Materialized available: use stored value (including 0).
 * - Legacy unmigrated slots: derive available from old totalPlants once.
 * - Capacity (display) = available + booked.
 */
export const resolveSlotBufferFields = (
  slot,
  { subtypeBuffer = 0, plantBuffer = 0 } = {}
) => {
  const booked = Number(slot?.totalBookedPlants) || 0;
  const availablePlants = resolveStoredAvailable(slot, booked);
  const capacity = deriveSlotCapacity(availablePlants, booked);
  const materialized = isSlotBufferMaterialized(slot);
  const availableMaterialized = isAvailablePlantsMaterialized(slot);

  const effectiveBuffer = materialized
    ? finiteNumber(slot?.effectiveBuffer) ??
      finiteNumber(slot?.buffer) ??
      0
    : calculateEffectiveBuffer(slot?.buffer || 0, subtypeBuffer, plantBuffer);

  const bufferAdjusted = calculateBufferAdjustedCapacity(capacity, booked, effectiveBuffer);
  const computedBufferAmount = bufferAdjusted.bufferAmount;
  const inheritedBufferAmount = materialized
    ? 0
    : Math.round(computedBufferAmount);

  const storedBufferRaw = finiteNumber(slot?.bufferAmount);
  const hasStoredBuffer = storedBufferRaw != null && storedBufferRaw > 0;
  const bufferAmount = hasStoredBuffer ? storedBufferRaw : 0;

  let displayBufferAmount;
  if (hasStoredBuffer) {
    displayBufferAmount = storedBufferRaw;
  } else if (materialized) {
    displayBufferAmount = 0;
  } else {
    displayBufferAmount = inheritedBufferAmount;
  }

  const effectiveBufferAmount = hasStoredBuffer
    ? storedBufferRaw
    : materialized
    ? 0
    : computedBufferAmount;

  return {
    effectiveBuffer,
    bufferAdjustedCapacity: Math.max(0, capacity - effectiveBufferAmount),
    bufferAmount,
    displayBufferAmount,
    computedBufferAmount: inheritedBufferAmount,
    inheritedBufferAmount,
    hasStoredBuffer,
    bufferMaterialized: materialized,
    inheritedBufferOnly: !materialized && !hasStoredBuffer && inheritedBufferAmount > 0,
    availablePlants,
    availablePlantsMaterialized: availableMaterialized,
    totalCapacity: capacity,
  };
};

export const releaseBufferPlants = (slotData, plantsToRelease) => {
  const currentBufferAmount = slotData.bufferAmount || 0;
  const currentAvailablePlants = slotData.availablePlants || 0;
  const currentTotalPlants = slotData.totalPlants || 0;
  
  const maxReleasable = Math.min(currentBufferAmount, plantsToRelease);
  
  if (maxReleasable <= 0) {
    return {
      success: false,
      message: "No buffer plants available to release",
      released: 0
    };
  }
  
  const newBufferAmount = currentBufferAmount - maxReleasable;
  const newAvailablePlants = currentAvailablePlants + maxReleasable;
  const newBufferPercentage = currentTotalPlants > 0 ? (newBufferAmount / currentTotalPlants) * 100 : 0;
  
  return {
    success: true,
    released: maxReleasable,
    newBufferAmount,
    newAvailablePlants,
    newBufferPercentage,
    message: `Released ${maxReleasable} plants from buffer`
  };
};

export const addPlantsToCapacity = (slotData, plantsToAdd) => {
  const currentAvailablePlants = slotData.availablePlants || 0;
  const currentBookedPlants = slotData.totalBookedPlants || 0;
  const currentBufferAmount = slotData.bufferAmount || 0;
  
  const newAvailablePlants = currentAvailablePlants + plantsToAdd;
  const newTotalPlants = newAvailablePlants + currentBookedPlants;
  const newBufferPercentage = newTotalPlants > 0 ? (currentBufferAmount / newTotalPlants) * 100 : 0;
  
  return {
    success: true,
    newTotalPlants,
    newBufferAmount: currentBufferAmount,
    newAvailablePlants,
    newBufferPercentage,
    message: `Added ${plantsToAdd} plants to available plants`
  };
}; 

export const addPlantsToAvailable = (slotData, plantsToAdd) => {
  const currentAvailablePlants = slotData.availablePlants || 0;
  const currentBookedPlants = slotData.totalBookedPlants || 0;
  const currentBufferAmount = slotData.bufferAmount || 0;
  
  const newAvailablePlants = currentAvailablePlants + plantsToAdd;
  const newTotalPlants = newAvailablePlants + currentBookedPlants;
  const newBufferPercentage = newTotalPlants > 0 ? (currentBufferAmount / newTotalPlants) * 100 : 0;
  
  return {
    success: true,
    newTotalPlants,
    newBufferAmount: currentBufferAmount,
    newAvailablePlants,
    newBufferPercentage,
    message: `Added ${plantsToAdd} plants to available plants`
  };
};
