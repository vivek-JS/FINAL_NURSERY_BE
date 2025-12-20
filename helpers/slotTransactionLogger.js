import moment from 'moment';

/**
 * Slot Transaction Logger Helper
 * Provides utilities to log all slot changes and transactions
 */

/**
 * Log sowing request creation
 * @param {Object} slot - The slot document
 * @param {String} sowingRequestId - ID of the sowing request
 * @param {Number} quantity - Quantity of packets/plants
 * @param {String} userId - User who created the request
 * @param {Object} options - Additional options { isExcessive, notes }
 */
export const logSowingRequestCreated = (slot, sowingRequestId, quantity, userId, options = {}) => {
  const trailEntry = {
    action: 'STOCK_REQUEST_CREATED',
    quantity,
    previousTotalPlants: slot.totalPlants || 0,
    newTotalPlants: slot.totalPlants || 0,
    previousAvailablePlants: slot.availablePlants || 0,
    newAvailablePlants: slot.availablePlants || 0,
    bufferPercentage: slot.effectiveBuffer || slot.buffer || 0,
    bufferAmount: slot.bufferAmount || 0,
    reason: options.isExcessive ? 'Excessive sowing request created' : 'Sowing request created',
    sowingRequestId,
    performedBy: userId,
    notes: options.notes || `Stock request created for ${quantity} packets`,
  };

  if (!slot.slotTrail) {
    slot.slotTrail = [];
  }
  
  slot.slotTrail.unshift(trailEntry);
  
  // Add to linked requests
  if (!slot.linkedSowingRequests) {
    slot.linkedSowingRequests = [];
  }
  if (!slot.linkedSowingRequests.includes(sowingRequestId)) {
    slot.linkedSowingRequests.push(sowingRequestId);
  }
};

/**
 * Log sowing request issued
 * @param {Object} slot - The slot document
 * @param {String} sowingRequestId - ID of the sowing request
 * @param {Number} quantity - Quantity issued
 * @param {String} userId - User who issued
 * @param {Object} options - Additional options { outwardId, notes }
 */
export const logSowingRequestIssued = (slot, sowingRequestId, quantity, userId, options = {}) => {
  const trailEntry = {
    action: 'STOCK_REQUEST_ISSUED',
    quantity,
    previousTotalPlants: slot.totalPlants || 0,
    newTotalPlants: slot.totalPlants || 0,
    previousAvailablePlants: slot.availablePlants || 0,
    newAvailablePlants: slot.availablePlants || 0,
    bufferPercentage: slot.effectiveBuffer || slot.buffer || 0,
    bufferAmount: slot.bufferAmount || 0,
    reason: 'Stock issued for sowing',
    sowingRequestId,
    performedBy: userId,
    notes: options.notes || `Stock issued: ${quantity} packets. Outward: ${options.outwardId || 'N/A'}`,
  };

  if (!slot.slotTrail) {
    slot.slotTrail = [];
  }
  
  slot.slotTrail.unshift(trailEntry);
  
  // Mark sowing as in progress
  slot.sowingInProgress = true;
};

/**
 * Log sowing started
 * @param {Object} slot - The slot document
 * @param {Number} quantity - Quantity being sowed
 * @param {String} userId - User who started sowing
 * @param {Object} options - Additional options { sowingDate, location, notes }
 */
export const logSowingStarted = (slot, quantity, userId, options = {}) => {
  const trailEntry = {
    action: 'SOWING_STARTED',
    quantity,
    previousTotalPlants: slot.totalPlants || 0,
    newTotalPlants: slot.totalPlants || 0,
    previousAvailablePlants: slot.availablePlants || 0,
    newAvailablePlants: slot.availablePlants || 0,
    bufferPercentage: slot.effectiveBuffer || slot.buffer || 0,
    bufferAmount: slot.bufferAmount || 0,
    reason: `Sowing started at ${options.location || 'UNKNOWN'}`,
    performedBy: userId,
    notes: options.notes || `Sowing started: ${quantity} plants on ${options.sowingDate || moment().format('DD-MM-YYYY')}`,
  };

  if (!slot.slotTrail) {
    slot.slotTrail = [];
  }
  
  slot.slotTrail.unshift(trailEntry);
  
  slot.sowingInProgress = true;
};

/**
 * Log sowing completed
 * @param {Object} slot - The slot document
 * @param {Number} quantity - Total quantity sowed
 * @param {String} userId - User who completed sowing
 * @param {Object} options - Additional options { notes }
 */
export const logSowingCompleted = (slot, quantity, userId, options = {}) => {
  const trailEntry = {
    action: 'SOWING_COMPLETED',
    quantity,
    previousTotalPlants: slot.totalPlants || 0,
    newTotalPlants: slot.totalPlants || 0,
    previousAvailablePlants: slot.availablePlants || 0,
    newAvailablePlants: slot.availablePlants || 0,
    bufferPercentage: slot.effectiveBuffer || slot.buffer || 0,
    bufferAmount: slot.bufferAmount || 0,
    reason: 'Sowing completed',
    performedBy: userId,
    notes: options.notes || `Sowing completed: ${quantity} plants sowed`,
  };

  if (!slot.slotTrail) {
    slot.slotTrail = [];
  }
  
  slot.slotTrail.unshift(trailEntry);
  
  slot.sowingCompleted = true;
  slot.sowingCompletedDate = moment().format('DD-MM-YYYY');
  slot.sowingInProgress = false;
};

/**
 * Log excessive sowing added
 * @param {Object} slot - The slot document
 * @param {Number} packets - Excessive packets
 * @param {Number} plants - Excessive plants
 * @param {String} userId - User who added
 * @param {Object} options - Additional options { notes }
 */
export const logExcessiveSowingAdded = (slot, packets, plants, userId, options = {}) => {
  const trailEntry = {
    action: 'EXCESSIVE_SOWING_ADDED',
    quantity: plants,
    previousTotalPlants: slot.totalPlants || 0,
    newTotalPlants: slot.totalPlants || 0,
    previousAvailablePlants: slot.availablePlants || 0,
    newAvailablePlants: slot.availablePlants || 0,
    bufferPercentage: slot.effectiveBuffer || slot.buffer || 0,
    bufferAmount: slot.bufferAmount || 0,
    reason: 'Excessive sowing added (no orders)',
    performedBy: userId,
    notes: options.notes || `Excessive sowing: ${packets} packets → ${plants} plants`,
  };

  if (!slot.slotTrail) {
    slot.slotTrail = [];
  }
  
  slot.slotTrail.unshift(trailEntry);
  
  // Update excessive sowing tracking
  if (!slot.excessiveSowing) {
    slot.excessiveSowing = { packets: 0, plants: 0 };
  }
  slot.excessiveSowing.packets += packets;
  slot.excessiveSowing.plants += plants;
};

/**
 * Log request cancellation
 * @param {Object} slot - The slot document
 * @param {String} sowingRequestId - ID of the sowing request
 * @param {String} userId - User who cancelled
 * @param {Object} options - Additional options { reason, notes }
 */
export const logSowingRequestCancelled = (slot, sowingRequestId, userId, options = {}) => {
  const trailEntry = {
    action: 'STOCK_REQUEST_CANCELLED',
    quantity: 0,
    previousTotalPlants: slot.totalPlants || 0,
    newTotalPlants: slot.totalPlants || 0,
    previousAvailablePlants: slot.availablePlants || 0,
    newAvailablePlants: slot.availablePlants || 0,
    bufferPercentage: slot.effectiveBuffer || slot.buffer || 0,
    bufferAmount: slot.bufferAmount || 0,
    reason: options.reason || 'Sowing request cancelled',
    sowingRequestId,
    performedBy: userId,
    notes: options.notes || 'Stock request cancelled',
  };

  if (!slot.slotTrail) {
    slot.slotTrail = [];
  }
  
  slot.slotTrail.unshift(trailEntry);
};

/**
 * Calculate remaining sowing needed for a slot
 * @param {Object} slot - The slot document
 * @param {Number} totalBookedPlants - Total booked plants from orders
 * @returns {Number} - Remaining plants to sow
 */
export const calculateRemainingSowing = (slot, totalBookedPlants) => {
  const totalSowed = (slot.primarySowed || 0) + (slot.officeSowed || 0);
  const remaining = Math.max(0, totalBookedPlants - totalSowed);
  return remaining;
};

/**
 * Get slot transaction history
 * @param {Object} slot - The slot document
 * @param {Object} options - Filter options { limit, action }
 * @returns {Array} - Array of trail entries
 */
export const getSlotTransactionHistory = (slot, options = {}) => {
  let trail = slot.slotTrail || [];
  
  // Filter by action if specified
  if (options.action) {
    trail = trail.filter(entry => entry.action === options.action);
  }
  
  // Apply limit
  if (options.limit && options.limit > 0) {
    trail = trail.slice(0, options.limit);
  }
  
  return trail;
};

export default {
  logSowingRequestCreated,
  logSowingRequestIssued,
  logSowingStarted,
  logSowingCompleted,
  logExcessiveSowingAdded,
  logSowingRequestCancelled,
  calculateRemainingSowing,
  getSlotTransactionHistory,
};


