import Order from '../models/order.model.js';

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
            $nin: ['CANCELLED', 'REJECTED'] // Exclude cancelled/rejected orders
          }
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
            $nin: ['CANCELLED', 'REJECTED'] // Exclude cancelled/rejected orders
          }
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
 * Get slot information with dynamically calculated booked plants
 * @param {string} slotId - The slot ID
 * @returns {Promise<Object>} - Slot info with calculated booked plants
 */
export const getSlotInfoWithBookedPlants = async (slotId) => {
  try {
    // Find the slot
    const PlantSlot = (await import('../models/slots.model.js')).default;
    
    const plantSlot = await PlantSlot.findOne(
      { "subtypeSlots.slots._id": slotId },
      { "subtypeSlots.$": 1 }
    );

    if (!plantSlot || !plantSlot.subtypeSlots[0]) {
      return null;
    }

    const targetSlot = plantSlot.subtypeSlots[0].slots.find(
      (slot) => slot._id.toString() === slotId.toString()
    );

    if (!targetSlot) {
      return null;
    }

    // Calculate booked plants dynamically
    const totalBookedPlants = await calculateSlotBookedPlants(slotId);
    
    // Calculate available plants
    const availablePlants = Math.max(0, targetSlot.totalPlants - totalBookedPlants);
    const isOverflow = totalBookedPlants > targetSlot.totalPlants;

    return {
      slotId: targetSlot._id,
      totalPlants: targetSlot.totalPlants,
      totalBookedPlants: totalBookedPlants,
      availablePlants: availablePlants,
      isOverflow: isOverflow,
      startDay: targetSlot.startDay,
      endDay: targetSlot.endDay,
      month: targetSlot.month,
      buffer: targetSlot.buffer,
      effectiveBuffer: targetSlot.effectiveBuffer,
      bufferAdjustedCapacity: targetSlot.bufferAdjustedCapacity,
      bufferAmount: targetSlot.bufferAmount,
      originalTotalPlants: targetSlot.originalTotalPlants,
    };
  } catch (error) {
    console.error('Error getting slot info with booked plants:', error);
    return null;
  }
}; 