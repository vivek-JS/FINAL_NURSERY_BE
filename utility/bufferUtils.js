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
  const availablePlants = calculateAvailablePlants(totalPlants, bufferPercentage);
  return {
    availablePlants: Math.max(0, availablePlants - totalBookedPlants),
    totalCapacity: totalPlants,
    bufferAdjustedCapacity: availablePlants,
    bufferAmount: (totalPlants * bufferPercentage) / 100
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