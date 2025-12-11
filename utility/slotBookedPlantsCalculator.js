import Order from '../models/order.model.js';
import mongoose from 'mongoose';

/**
 * Calculate total booked plants for a specific slot from actual orders
 * @param {string} slotId - The slot ID to calculate booked plants for
 * @returns {Promise<number>} - Total number of booked plants
 */
export const calculateSlotBookedPlants = async (slotId) => {
  try {
    const result = await Order.aggregate([
      {
        $match: {
          bookingSlot: slotId,
          orderStatus: { 
            $nin: ['CANCELLED', 'REJECTED'] // Exclude cancelled/rejected orders - COMPLETED orders count in booked
          },
          // Exclude dealer quota orders - exclude orders where quotaSource is "dealer"
          $and: [
            {
              $or: [
                { quotaSource: { $ne: "dealer" } }, // quotaSource is not "dealer"
                { quotaSource: { $exists: false } } // quotaSource field doesn't exist
              ]
            }
          ]
        }
      },
      {
        $group: {
          _id: null,
          totalBookedPlants: { $sum: '$numberOfPlants' }
        }
      }
    ]);

    return result.length > 0 ? result[0].totalBookedPlants : 0;
  } catch (error) {
    console.error('Error calculating slot booked plants:', error);
    return 0;
  }
};

/**
 * Calculate total booked plants for multiple slots efficiently
 * @param {Array<string>} slotIds - Array of slot IDs
 * @returns {Promise<Object>} - Object with slotId as key and booked plants as value
 */
export const calculateMultipleSlotsBookedPlants = async (slotIds) => {
  try {
    const result = await Order.aggregate([
      {
        $match: {
          bookingSlot: { $in: slotIds },
          orderStatus: { 
            $nin: ['CANCELLED', 'REJECTED'] // Exclude cancelled/rejected orders - COMPLETED orders count in booked
          },
          // Exclude dealer quota orders - exclude orders where quotaSource is "dealer"
          $and: [
            {
              $or: [
                { quotaSource: { $ne: "dealer" } }, // quotaSource is not "dealer"
                { quotaSource: { $exists: false } } // quotaSource field doesn't exist
              ]
            }
          ]
        }
      },
      {
        $group: {
          _id: '$bookingSlot',
          totalBookedPlants: { $sum: '$numberOfPlants' }
        }
      }
    ]);

    // Convert to object format
    const bookedPlantsMap = {};
    result.forEach(item => {
      bookedPlantsMap[item._id.toString()] = item.totalBookedPlants;
    });

    // Ensure all requested slotIds have a value (default to 0)
    slotIds.forEach(slotId => {
      if (!bookedPlantsMap[slotId]) {
        bookedPlantsMap[slotId] = 0;
      }
    });

    return bookedPlantsMap;
  } catch (error) {
    console.error('Error calculating multiple slots booked plants:', error);
    // Return default values for all slots
    const defaultMap = {};
    slotIds.forEach(slotId => {
      defaultMap[slotId] = 0;
    });
    return defaultMap;
  }
};

/**
 * Get detailed slot information including booked plants calculation
 * @param {string} slotId - The slot ID to get info for
 * @returns {Promise<Object|null>} - Slot information with calculated values
 */
export const getSlotInfoWithBookedPlants = async (slotId) => {
  try {
    const PlantSlot = mongoose.model('PlantSlot');
    
    // Find the slot
    const plantSlot = await PlantSlot.findOne(
      { "subtypeSlots.slots._id": slotId },
      { "subtypeSlots.$": 1 }
    );

    if (!plantSlot || !plantSlot.subtypeSlots[0]) {
      return null;
    }

    const slot = plantSlot.subtypeSlots[0].slots.find(
      (s) => s._id.toString() === slotId.toString()
    );

    if (!slot) {
      return null;
    }

    // Calculate booked plants from active orders
    const totalBookedPlants = await calculateSlotBookedPlants(slotId);

    // Calculate available plants as totalPlants - totalBookedPlants
    const availablePlants = Math.max(0, slot.totalPlants - totalBookedPlants);
    
    // Calculate buffer-adjusted values for reference
    const effectiveBuffer = slot.effectiveBuffer || slot.buffer || 0;
    const bufferAmount = Math.round((slot.totalPlants * effectiveBuffer) / 100);
    const bufferAdjustedCapacity = slot.totalPlants - bufferAmount;

    return {
      slotId: slot._id,
      startDay: slot.startDay,
      endDay: slot.endDay,
      month: slot.month,
      totalPlants: slot.totalPlants,
      totalBookedPlants: totalBookedPlants,
      availablePlants: availablePlants,
      isOverflow: availablePlants < 0,
      buffer: slot.buffer || 0,
      effectiveBuffer: effectiveBuffer,
      bufferAdjustedCapacity: bufferAdjustedCapacity,
      bufferAmount: bufferAmount,
      originalTotalPlants: slot.originalTotalPlants || slot.totalPlants
    };
  } catch (error) {
    console.error('Error getting slot info with booked plants:', error);
    return null;
  }
}; 