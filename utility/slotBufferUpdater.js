import PlantSlot from '../models/slots.model.js';
import PlantCms from '../models/plantCms.model.js';
import { calculateEffectiveBuffer, calculateBufferAdjustedCapacity } from './bufferUtils.js';

/**
 * Update buffer calculations for all slots in the database
 */
export const updateAllSlotBuffers = async () => {
  try {
    console.log('🔄 Starting buffer calculation update for all slots...');
    
    const plantSlots = await PlantSlot.find({}).populate('plantId');
    let updatedCount = 0;
    
    for (const plantSlot of plantSlots) {
      const plant = plantSlot.plantId;
      if (!plant) continue;
      
      const plantBuffer = plant.buffer || 0;
      
      for (const subtypeSlot of plantSlot.subtypeSlots) {
        // Find subtype buffer
        const subtype = plant.subtypes.find(sub => sub._id.toString() === subtypeSlot.subtypeId.toString());
        const subtypeBuffer = subtype?.buffer || 0;
        
        for (const slot of subtypeSlot.slots) {
          // Calculate effective buffer
          const effectiveBuffer = calculateEffectiveBuffer(
            slot.buffer || 0,
            subtypeBuffer,
            plantBuffer
          );
          
          // Calculate buffer-adjusted values
          const bufferAdjusted = calculateBufferAdjustedCapacity(
            slot.totalPlants,
            slot.totalBookedPlants,
            effectiveBuffer
          );
          
          // Update slot with buffer calculations
          const updates = {
            effectiveBuffer,
            bufferAdjustedCapacity: bufferAdjusted.bufferAdjustedCapacity,
            availablePlants: bufferAdjusted.availablePlants,
            bufferAmount: bufferAdjusted.bufferAmount,
            originalTotalPlants: slot.totalPlants
          };
          
          // Update the slot in the database
          await PlantSlot.updateOne(
            { 
              _id: plantSlot._id,
              'subtypeSlots.subtypeId': subtypeSlot.subtypeId,
              'subtypeSlots.slots._id': slot._id
            },
            {
              $set: {
                'subtypeSlots.$.slots.$[slotElem].effectiveBuffer': updates.effectiveBuffer,
                'subtypeSlots.$.slots.$[slotElem].bufferAdjustedCapacity': updates.bufferAdjustedCapacity,
                'subtypeSlots.$.slots.$[slotElem].availablePlants': updates.availablePlants,
                'subtypeSlots.$.slots.$[slotElem].bufferAmount': updates.bufferAmount,
                'subtypeSlots.$.slots.$[slotElem].originalTotalPlants': updates.originalTotalPlants
              }
            },
            {
              arrayFilters: [{ 'slotElem._id': slot._id }]
            }
          );
          
          updatedCount++;
        }
      }
    }
    
    console.log(`✅ Buffer calculations updated for ${updatedCount} slots`);
    return { success: true, updatedCount };
    
  } catch (error) {
    console.error('❌ Error updating buffer calculations:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Update buffer calculations for a specific plant
 */
export const updatePlantSlotBuffers = async (plantId) => {
  try {
    console.log(`🔄 Updating buffer calculations for plant: ${plantId}`);
    
    const plantSlot = await PlantSlot.findOne({ plantId }).populate('plantId');
    if (!plantSlot) {
      return { success: false, error: 'Plant slot not found' };
    }
    
    const plant = plantSlot.plantId;
    if (!plant) {
      return { success: false, error: 'Plant not found' };
    }
    
    const plantBuffer = plant.buffer || 0;
    let updatedCount = 0;
    
    for (const subtypeSlot of plantSlot.subtypeSlots) {
      // Find subtype buffer
      const subtype = plant.subtypes.find(sub => sub._id.toString() === subtypeSlot.subtypeId.toString());
      const subtypeBuffer = subtype?.buffer || 0;
      
      for (const slot of subtypeSlot.slots) {
        // Calculate effective buffer
        const effectiveBuffer = calculateEffectiveBuffer(
          slot.buffer || 0,
          subtypeBuffer,
          plantBuffer
        );
        
        // Calculate buffer-adjusted values
        const bufferAdjusted = calculateBufferAdjustedCapacity(
          slot.totalPlants,
          slot.totalBookedPlants,
          effectiveBuffer
        );
        
        // Update slot with buffer calculations
        await PlantSlot.updateOne(
          { 
            _id: plantSlot._id,
            'subtypeSlots.subtypeId': subtypeSlot.subtypeId,
            'subtypeSlots.slots._id': slot._id
          },
          {
            $set: {
              'subtypeSlots.$.slots.$[slotElem].effectiveBuffer': effectiveBuffer,
              'subtypeSlots.$.slots.$[slotElem].bufferAdjustedCapacity': bufferAdjusted.bufferAdjustedCapacity,
              'subtypeSlots.$.slots.$[slotElem].availablePlants': bufferAdjusted.availablePlants,
              'subtypeSlots.$.slots.$[slotElem].bufferAmount': bufferAdjusted.bufferAmount,
              'subtypeSlots.$.slots.$[slotElem].originalTotalPlants': slot.totalPlants
            }
          },
          {
            arrayFilters: [{ 'slotElem._id': slot._id }]
          }
        );
        
        updatedCount++;
      }
    }
    
    console.log(`✅ Buffer calculations updated for ${updatedCount} slots in plant ${plantId}`);
    return { success: true, updatedCount };
    
  } catch (error) {
    console.error('❌ Error updating plant buffer calculations:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Update buffer calculations when slot data changes
 */
export const updateSlotBufferCalculations = async (slotId, newTotalPlants, newTotalBookedPlants, newBuffer = null) => {
  try {
    // Find the slot
    const plantSlot = await PlantSlot.findOne({ 'subtypeSlots.slots._id': slotId }).populate('plantId');
    if (!plantSlot) {
      return { success: false, error: 'Slot not found' };
    }
    
    const plant = plantSlot.plantId;
    if (!plant) {
      return { success: false, error: 'Plant not found' };
    }
    
    // Find the specific slot
    let targetSlot = null;
    let targetSubtypeSlot = null;
    
    for (const subtypeSlot of plantSlot.subtypeSlots) {
      for (const slot of subtypeSlot.slots) {
        if (slot._id.toString() === slotId) {
          targetSlot = slot;
          targetSubtypeSlot = subtypeSlot;
          break;
        }
      }
      if (targetSlot) break;
    }
    
    if (!targetSlot) {
      return { success: false, error: 'Target slot not found' };
    }
    
    // Find subtype buffer
    const subtype = plant.subtypes.find(sub => sub._id.toString() === targetSubtypeSlot.subtypeId.toString());
    const subtypeBuffer = subtype?.buffer || 0;
    const plantBuffer = plant.buffer || 0;
    
    // Use new buffer if provided, otherwise use existing
    const slotBuffer = newBuffer !== null ? newBuffer : (targetSlot.buffer || 0);
    
    // Calculate effective buffer
    const effectiveBuffer = calculateEffectiveBuffer(
      slotBuffer,
      subtypeBuffer,
      plantBuffer
    );
    
    // Calculate buffer-adjusted values
    const bufferAdjusted = calculateBufferAdjustedCapacity(
      newTotalPlants,
      newTotalBookedPlants,
      effectiveBuffer
    );
    
    // Update the slot
    await PlantSlot.updateOne(
      { 
        _id: plantSlot._id,
        'subtypeSlots.subtypeId': targetSubtypeSlot.subtypeId,
        'subtypeSlots.slots._id': slotId
      },
      {
        $set: {
          'subtypeSlots.$.slots.$[slotElem].totalPlants': newTotalPlants,
          'subtypeSlots.$.slots.$[slotElem].totalBookedPlants': newTotalBookedPlants,
          'subtypeSlots.$.slots.$[slotElem].buffer': slotBuffer,
          'subtypeSlots.$.slots.$[slotElem].effectiveBuffer': effectiveBuffer,
          'subtypeSlots.$.slots.$[slotElem].bufferAdjustedCapacity': bufferAdjusted.bufferAdjustedCapacity,
          'subtypeSlots.$.slots.$[slotElem].availablePlants': bufferAdjusted.availablePlants,
          'subtypeSlots.$.slots.$[slotElem].bufferAmount': bufferAdjusted.bufferAmount,
          'subtypeSlots.$.slots.$[slotElem].originalTotalPlants': newTotalPlants
        }
      },
      {
        arrayFilters: [{ 'slotElem._id': slotId }]
      }
    );
    
    return { 
      success: true, 
      effectiveBuffer,
      availablePlants: bufferAdjusted.availablePlants,
      bufferAmount: bufferAdjusted.bufferAmount
    };
    
  } catch (error) {
    console.error('❌ Error updating slot buffer calculations:', error);
    return { success: false, error: error.message };
  }
}; 