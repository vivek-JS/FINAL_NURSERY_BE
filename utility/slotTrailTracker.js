import PlantSlot from '../models/slots.model.js';
import { calculateEffectiveBuffer, calculateBufferAdjustedCapacity } from './bufferUtils.js';

/**
 * Add a trail entry to track slot changes
 * @param {string} slotId - The slot ID
 * @param {Object} trailData - Trail data object
 * @returns {Promise<Object>} - Result of the operation
 */
export const addSlotTrailEntry = async (slotId, trailData) => {
  try {
    const {
      action,
      quantity,
      previousTotalPlants,
      newTotalPlants,
      previousAvailablePlants,
      newAvailablePlants,
      bufferPercentage,
      bufferAmount,
      reason,
      orderId,
      performedBy,
      notes
    } = trailData;

    // Get activity name from action
    const getActivityName = (action) => {
      const activityNameMap = {
        'ADD': 'Plants Added',
        'SUBTRACT': 'Plants Subtracted',
        'BUFFER_APPLIED': 'Buffer Applied',
        'BUFFER_RELEASED': 'Buffer Released',
        'UPDATE': 'Slot Updated',
        'ORDER_CANCELLED': 'Order Cancelled',
        'ORDER_RETURNED': 'Order Returned',
      };
      return activityNameMap[action] || action.replace(/_/g, ' ');
    };

    // Find the slot and add trail entry
    const result = await PlantSlot.updateOne(
      { "subtypeSlots.slots._id": slotId },
      {
        $push: {
          "subtypeSlots.$[].slots.$[slotElem].slotTrail": {
            action: action || 'UPDATE',
            activityName: getActivityName(action || 'UPDATE'),
            quantity: quantity ?? 0,
            previousTotalPlants: previousTotalPlants ?? 0,
            newTotalPlants: newTotalPlants ?? 0,
            previousAvailablePlants: previousAvailablePlants ?? 0,
            newAvailablePlants: newAvailablePlants ?? 0,
            bufferPercentage: bufferPercentage ?? 0,
            bufferAmount: bufferAmount ?? 0,
            reason: reason || 'Slot activity',
            orderId: orderId || null,
            performedBy: performedBy || null,
            notes: notes || '',
            // Ensure plus/minus/before/after are properly initialized
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
            before: {
              primarySowed: 0,
              officeSowed: 0,
              totalPlants: previousTotalPlants ?? 0,
              availablePlants: previousAvailablePlants ?? 0,
              excessivePlants: 0,
              plantsSowed: 0,
              totalBookedPlants: 0,
              inProgressCount: 0,
            },
            after: {
              primarySowed: 0,
              officeSowed: 0,
              totalPlants: newTotalPlants ?? 0,
              availablePlants: newAvailablePlants ?? 0,
              excessivePlants: 0,
              plantsSowed: 0,
              totalBookedPlants: 0,
              inProgressCount: 0,
            },
            metadata: {},
          }
        }
      },
      {
        arrayFilters: [{ "slotElem._id": slotId }],
        new: true
      }
    );

    return { success: true, result };
  } catch (error) {
    console.error('Error adding slot trail entry:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Get slot trail history
 * @param {string} slotId - The slot ID
 * @returns {Promise<Array>} - Array of trail entries
 */
export const getSlotTrail = async (slotId) => {
  try {
    const plantSlot = await PlantSlot.findOne(
      { "subtypeSlots.slots._id": slotId },
      { "subtypeSlots.$": 1 }
    );

    if (!plantSlot || !plantSlot.subtypeSlots[0]) {
      return [];
    }

    const slot = plantSlot.subtypeSlots[0].slots.find(
      (s) => s._id.toString() === slotId.toString()
    );

    if (!slot || !slot.slotTrail) {
      return [];
    }

    // Sort by timestamp (newest first)
    return slot.slotTrail.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch (error) {
    console.error('Error getting slot trail:', error);
    return [];
  }
};

/**
 * Track order addition to slot
 * @param {string} slotId - The slot ID
 * @param {number} quantity - Number of plants added
 * @param {string} orderId - The order ID
 * @param {string} performedBy - User ID who performed the action
 * @param {string} reason - Reason for the action
 * @returns {Promise<Object>} - Result of the operation
 */
export const trackOrderAddition = async (slotId, quantity, orderId, performedBy, reason = "Order booked") => {
  try {
    // Get current slot state
    const plantSlot = await PlantSlot.findOne(
      { "subtypeSlots.slots._id": slotId },
      { "subtypeSlots.$": 1 }
    );

    if (!plantSlot || !plantSlot.subtypeSlots[0]) {
      return { success: false, error: "Slot not found" };
    }

    const slot = plantSlot.subtypeSlots[0].slots.find(
      (s) => s._id.toString() === slotId.toString()
    );

    if (!slot) {
      return { success: false, error: "Slot not found" };
    }

    const trailData = {
      action: "SUBTRACT",
      quantity,
      previousTotalPlants: slot.totalPlants,
      newTotalPlants: slot.totalPlants, // totalPlants doesn't change
      previousAvailablePlants: slot.availablePlants,
      newAvailablePlants: slot.availablePlants - quantity,
      bufferPercentage: slot.effectiveBuffer || slot.buffer || 0,
      bufferAmount: slot.bufferAmount || 0,
      reason,
      orderId,
      performedBy,
      notes: `Order #${orderId} booked - ${quantity} plants`
    };

    return await addSlotTrailEntry(slotId, trailData);
  } catch (error) {
    console.error('Error tracking order addition:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Track order cancellation/return from slot
 * @param {string} slotId - The slot ID
 * @param {number} quantity - Number of plants returned
 * @param {string} orderId - The order ID
 * @param {string} performedBy - User ID who performed the action
 * @param {string} reason - Reason for the action
 * @returns {Promise<Object>} - Result of the operation
 */
export const trackOrderReturn = async (slotId, quantity, orderId, performedBy, reason = "Order cancelled/returned") => {
  try {
    // Get current slot state
    const plantSlot = await PlantSlot.findOne(
      { "subtypeSlots.slots._id": slotId },
      { "subtypeSlots.$": 1 }
    );

    if (!plantSlot || !plantSlot.subtypeSlots[0]) {
      return { success: false, error: "Slot not found" };
    }

    const slot = plantSlot.subtypeSlots[0].slots.find(
      (s) => s._id.toString() === slotId.toString()
    );

    if (!slot) {
      return { success: false, error: "Slot not found" };
    }

    const trailData = {
      action: "ADD",
      quantity,
      previousTotalPlants: slot.totalPlants,
      newTotalPlants: slot.totalPlants, // totalPlants doesn't change
      previousAvailablePlants: slot.availablePlants,
      newAvailablePlants: slot.availablePlants + quantity,
      bufferPercentage: slot.effectiveBuffer || slot.buffer || 0,
      bufferAmount: slot.bufferAmount || 0,
      reason,
      orderId,
      performedBy,
      notes: `Order #${orderId} cancelled/returned - ${quantity} plants freed up`
    };

    return await addSlotTrailEntry(slotId, trailData);
  } catch (error) {
    console.error('Error tracking order return:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Track buffer application
 * @param {string} slotId - The slot ID
 * @param {number} bufferPercentage - Buffer percentage applied
 * @param {string} performedBy - User ID who performed the action
 * @param {string} reason - Reason for the action
 * @returns {Promise<Object>} - Result of the operation
 */
export const trackBufferApplication = async (slotId, bufferPercentage, performedBy, reason = "Buffer applied") => {
  try {
    // Get current slot state
    const plantSlot = await PlantSlot.findOne(
      { "subtypeSlots.slots._id": slotId },
      { "subtypeSlots.$": 1 }
    );

    if (!plantSlot || !plantSlot.subtypeSlots[0]) {
      return { success: false, error: "Slot not found" };
    }

    const slot = plantSlot.subtypeSlots[0].slots.find(
      (s) => s._id.toString() === slotId.toString()
    );

    if (!slot) {
      return { success: false, error: "Slot not found" };
    }

    const bufferAmount = Math.round((slot.totalPlants * bufferPercentage) / 100);

    const trailData = {
      action: "BUFFER_APPLIED",
      quantity: bufferAmount,
      previousTotalPlants: slot.totalPlants,
      newTotalPlants: slot.totalPlants, // totalPlants doesn't change
      previousAvailablePlants: slot.availablePlants,
      newAvailablePlants: slot.availablePlants - bufferAmount,
      bufferPercentage,
      bufferAmount,
      reason,
      performedBy,
      notes: `Buffer ${bufferPercentage}% applied - ${bufferAmount} plants reserved`
    };

    return await addSlotTrailEntry(slotId, trailData);
  } catch (error) {
    console.error('Error tracking buffer application:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Track buffer release
 * @param {string} slotId - The slot ID
 * @param {number} bufferPercentage - Buffer percentage released
 * @param {string} performedBy - User ID who performed the action
 * @param {string} reason - Reason for the action
 * @returns {Promise<Object>} - Result of the operation
 */
export const trackBufferRelease = async (slotId, bufferPercentage, performedBy, reason = "Buffer released") => {
  try {
    // Get current slot state
    const plantSlot = await PlantSlot.findOne(
      { "subtypeSlots.slots._id": slotId },
      { "subtypeSlots.$": 1 }
    );

    if (!plantSlot || !plantSlot.subtypeSlots[0]) {
      return { success: false, error: "Slot not found" };
    }

    const slot = plantSlot.subtypeSlots[0].slots.find(
      (s) => s._id.toString() === slotId.toString()
    );

    if (!slot) {
      return { success: false, error: "Slot not found" };
    }

    const bufferAmount = Math.round((slot.totalPlants * bufferPercentage) / 100);

    const trailData = {
      action: "BUFFER_RELEASED",
      quantity: bufferAmount,
      previousTotalPlants: slot.totalPlants,
      newTotalPlants: slot.totalPlants, // totalPlants doesn't change
      previousAvailablePlants: slot.availablePlants,
      newAvailablePlants: slot.availablePlants + bufferAmount,
      bufferPercentage,
      bufferAmount,
      reason,
      performedBy,
      notes: `Buffer ${bufferPercentage}% released - ${bufferAmount} plants freed up`
    };

    return await addSlotTrailEntry(slotId, trailData);
  } catch (error) {
    console.error('Error tracking buffer release:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Track order booking in slot
 * @param {string} slotId - The slot ID
 * @param {number} quantity - Number of plants booked
 * @param {string} orderId - The order ID
 * @param {string} performedBy - User ID who performed the action
 * @param {string} reason - Reason for the action
 * @returns {Promise<Object>} - Result of the operation
 */
export const trackOrderBooking = async (slotId, quantity, orderId, performedBy, reason = "Order booked") => {
  try {
    // Find the slot and update it
    const plantSlot = await PlantSlot.findOne({ "subtypeSlots.slots._id": slotId });
    
    if (!plantSlot) {
      return { success: false, error: "Slot not found" };
    }

    // Find the specific slot
    let targetSlot = null;
    
    for (const subtype of plantSlot.subtypeSlots) {
      const slot = subtype.slots.find(s => s._id.toString() === slotId);
      if (slot) {
        targetSlot = slot;
        break;
      }
    }

    if (!targetSlot) {
      return { success: false, error: "Slot not found" };
    }

    // Set performer and track the order change
    targetSlot.setPerformer(performedBy);
    targetSlot.trackOrderChange("SUBTRACT", orderId, quantity, performedBy, reason);

    // Update available plants
    targetSlot.availablePlants = Math.max(0, targetSlot.availablePlants - quantity);

    // Save the document to trigger middleware
    await plantSlot.save();

    return { success: true, result: targetSlot };
  } catch (error) {
    console.error('Error tracking order booking:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Track order cancellation/return in slot
 * @param {string} slotId - The slot ID
 * @param {number} quantity - Number of plants returned
 * @param {string} orderId - The order ID
 * @param {string} performedBy - User ID who performed the action
 * @param {string} reason - Reason for the action
 * @returns {Promise<Object>} - Result of the operation
 */
export const trackOrderCancellation = async (slotId, quantity, orderId, performedBy, reason = "Order cancelled/returned") => {
  try {
    // Find the slot and update it
    const plantSlot = await PlantSlot.findOne({ "subtypeSlots.slots._id": slotId });
    
    if (!plantSlot) {
      return { success: false, error: "Slot not found" };
    }

    // Find the specific slot
    let targetSlot = null;
    
    for (const subtype of plantSlot.subtypeSlots) {
      const slot = subtype.slots.find(s => s._id.toString() === slotId);
      if (slot) {
        targetSlot = slot;
        break;
      }
    }

    if (!targetSlot) {
      return { success: false, error: "Slot not found" };
    }

    // Set performer and track the order change
    targetSlot.setPerformer(performedBy);
    targetSlot.trackOrderChange("ADD", orderId, quantity, performedBy, reason);

    // Update available plants
    targetSlot.availablePlants = targetSlot.availablePlants + quantity;

    // Save the document to trigger middleware
    await plantSlot.save();

    return { success: true, result: targetSlot };
  } catch (error) {
    console.error('Error tracking order cancellation:', error);
    return { success: false, error: error.message };
  }
}; 