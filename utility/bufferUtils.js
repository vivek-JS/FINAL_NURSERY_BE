/**
 * Calculate effective buffer percentage using cascading logic:
 * 1. Slot Buffer (highest priority)
 * 2. Plant Subtype Buffer (medium priority) 
 * 3. Plant Buffer (lowest priority)
 */
export const calculateEffectiveBuffer = (slotBuffer, subtypeBuffer, plantBuffer) => {
  // Priority: Slot > Subtype > Plant
  if (slotBuffer !== undefined && slotBuffer !== null && slotBuffer > 0) {
    return slotBuffer;
  }
  if (subtypeBuffer !== undefined && subtypeBuffer !== null && subtypeBuffer > 0) {
    return subtypeBuffer;
  }
  if (plantBuffer !== undefined && plantBuffer !== null && plantBuffer > 0) {
    return plantBuffer;
  }
  return 0; // Default to 0 if no buffer is set
};

/**
 * Calculate available plants after applying buffer
 * Available Plants = Total Plants - (Buffer % of Total Plants)
 */
export const calculateAvailablePlants = (totalPlants, bufferPercentage) => {
  const bufferAmount = (totalPlants * bufferPercentage) / 100;
  return Math.max(0, totalPlants - bufferAmount);
};

/**
 * Calculate buffer-adjusted capacity for display
 */
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

/** Slot had buffer saved/migrated/released — do not re-apply inherited plant/subtype %. */
export const isSlotBufferMaterialized = (slot) => {
  const original = finiteNumber(slot?.originalTotalPlants);
  if (original != null && original > 0) return true;
  const storedBuffer = finiteNumber(slot?.bufferAmount);
  if (storedBuffer != null && storedBuffer > 0) return true;
  const slotPct = finiteNumber(slot?.buffer);
  if (slotPct != null && slotPct > 0) return true;
  return false;
};

/**
 * Resolve buffer + available for API/UI from stored slot fields and effective buffer %.
 * - Preserves GRN / manual available above formula
 * - Fixes stale DB availablePlants=0 when capacity exists
 * - After release/save on slot: never substitute inherited plant/subtype reserve
 */
export const resolveSlotBufferFields = (
  slot,
  { subtypeBuffer = 0, plantBuffer = 0 } = {}
) => {
  const total = Number(slot?.totalPlants) || 0;
  const booked = Number(slot?.totalBookedPlants) || 0;
  const materialized = isSlotBufferMaterialized(slot);

  const effectiveBuffer = materialized
    ? finiteNumber(slot?.effectiveBuffer) ??
      finiteNumber(slot?.buffer) ??
      0
    : calculateEffectiveBuffer(slot?.buffer || 0, subtypeBuffer, plantBuffer);

  const bufferAdjusted = calculateBufferAdjustedCapacity(total, booked, effectiveBuffer);
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

  const formulaAvailable = total - booked - effectiveBufferAmount;

  const storedAvailableRaw = finiteNumber(slot?.availablePlants);
  let availablePlants;
  if (storedAvailableRaw == null) {
    availablePlants = formulaAvailable;
  } else {
    const isStaleZero =
      storedAvailableRaw === 0 &&
      total > 0 &&
      (booked > 0 || effectiveBuffer > 0 || formulaAvailable > 0);
    if (isStaleZero) {
      availablePlants = formulaAvailable;
    } else if (storedAvailableRaw > formulaAvailable + 0.001) {
      availablePlants = storedAvailableRaw;
    } else {
      availablePlants = storedAvailableRaw;
    }
  }

  return {
    effectiveBuffer,
    bufferAdjustedCapacity: Math.max(0, total - effectiveBufferAmount),
    bufferAmount,
    displayBufferAmount,
    computedBufferAmount: inheritedBufferAmount,
    inheritedBufferAmount,
    hasStoredBuffer,
    bufferMaterialized: materialized,
    inheritedBufferOnly: !materialized && !hasStoredBuffer && inheritedBufferAmount > 0,
    availablePlants,
  };
};

/**
 * Release plants from buffer to available plants
 * This moves plants from buffer reserve to available plants
 */
export const releaseBufferPlants = (slotData, plantsToRelease) => {
  const currentBufferAmount = slotData.bufferAmount || 0;
  const currentAvailablePlants = slotData.availablePlants || 0;
  const currentTotalPlants = slotData.totalPlants || 0;
  
  // Calculate how many plants can be released
  const maxReleasable = Math.min(currentBufferAmount, plantsToRelease);
  
  if (maxReleasable <= 0) {
    return {
      success: false,
      message: "No buffer plants available to release",
      released: 0
    };
  }
  
  // Calculate new values
  const newBufferAmount = currentBufferAmount - maxReleasable;
  const newAvailablePlants = currentAvailablePlants + maxReleasable;
  
  // Recalculate effective buffer percentage
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

/**
 * Add plants directly to total capacity (ignoring buffer)
 * This is used when editing plant capacity
 */
export const addPlantsToCapacity = (slotData, plantsToAdd) => {
  const currentTotalPlants = slotData.totalPlants || 0;
  const currentBufferPercentage = slotData.effectiveBuffer || 0;
  
  const newTotalPlants = currentTotalPlants + plantsToAdd;
  const newBufferAmount = (newTotalPlants * currentBufferPercentage) / 100;
  const newAvailablePlants = Math.max(0, newTotalPlants - newBufferAmount - (slotData.totalBookedPlants || 0));
  
  return {
    success: true,
    newTotalPlants,
    newBufferAmount,
    newAvailablePlants,
    message: `Added ${plantsToAdd} plants to total capacity`
  };
}; 

/**
 * Add plants directly to available plants without changing buffer amount
 * Buffer percentage will be recalculated based on new total plants
 */
export const addPlantsToAvailable = (slotData, plantsToAdd) => {
  const currentTotalPlants = slotData.totalPlants || 0;
  const currentBufferAmount = slotData.bufferAmount || 0;
  const currentAvailablePlants = slotData.availablePlants || 0;
  const currentBookedPlants = slotData.totalBookedPlants || 0;
  
  // Add plants directly to available plants
  const newAvailablePlants = currentAvailablePlants + plantsToAdd;
  
  // Calculate new total plants needed
  const newTotalPlants = newAvailablePlants + currentBookedPlants + currentBufferAmount;
  
  // Calculate new buffer percentage based on the unchanged buffer amount
  const newBufferPercentage = newTotalPlants > 0 ? (currentBufferAmount / newTotalPlants) * 100 : 0;
  
  return {
    success: true,
    newTotalPlants,
    newBufferAmount: currentBufferAmount, // Keep buffer amount unchanged
    newAvailablePlants,
    newBufferPercentage,
    message: `Added ${plantsToAdd} plants to available plants`
  };
}; 