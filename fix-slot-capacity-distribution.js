// Script to fix existing slots with proper capacity distribution
// This will redistribute the total capacity evenly across all slots for each plant/subtype

import dotenv from "dotenv";
dotenv.config();

import mongoose from 'mongoose';
import PlantCms from './models/plantCms.model.js';
import PlantSlot from './models/slots.model.js';
import moment from 'moment';

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL || 'mongodb://localhost:27017/nursery');
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Function to redistribute capacity across slots
const redistributeSlotCapacity = (slots, totalCapacity) => {
  if (slots.length === 0) return slots;
  
  // Calculate capacity per slot (distribute evenly)
  const capacityPerSlot = Math.floor(totalCapacity / slots.length);
  const remainingCapacity = totalCapacity % slots.length;
  
  // Update each slot with distributed capacity
  slots.forEach((slot, index) => {
    const slotCapacity = capacityPerSlot + (index < remainingCapacity ? 1 : 0);
    slot.totalPlants = slotCapacity;
    slot.originalTotalPlants = slotCapacity;
  });
  
  return slots;
};

// Fix slots for a specific plant and subtype
const fixSlotsForPlantSubtype = async (plantId, subtypeId, totalCapacity) => {
  try {
    console.log(`\n🔧 Fixing slots for plant: ${plantId}, subtype: ${subtypeId}`);
    console.log(`   Total capacity: ${totalCapacity.toLocaleString()} plants`);
    
    // Find all plant slots for this plant
    const plantSlots = await PlantSlot.find({ plantId: new mongoose.Types.ObjectId(plantId) });
    
    if (plantSlots.length === 0) {
      console.log('   ⚠️  No slots found for this plant');
      return;
    }
    
    let totalSlotsUpdated = 0;
    let totalCapacityRedistributed = 0;
    
    for (const plantSlot of plantSlots) {
      // Find the specific subtype slot
      const subtypeSlotIndex = plantSlot.subtypeSlots.findIndex(
        ss => ss.subtypeId.toString() === subtypeId
      );
      
      if (subtypeSlotIndex === -1) {
        console.log(`   ⚠️  No slots found for subtype in year ${plantSlot.year}`);
        continue;
      }
      
      const subtypeSlot = plantSlot.subtypeSlots[subtypeSlotIndex];
      const originalSlots = [...subtypeSlot.slots];
      
      // Redistribute capacity
      const updatedSlots = redistributeSlotCapacity(originalSlots, totalCapacity);
      
      // Calculate total capacity before and after
      const originalTotal = originalSlots.reduce((sum, slot) => sum + (slot.totalPlants || 0), 0);
      const newTotal = updatedSlots.reduce((sum, slot) => sum + slot.totalPlants, 0);
      
      console.log(`   📅 Year ${plantSlot.year}:`);
      console.log(`      Original total: ${originalTotal.toLocaleString()} plants`);
      console.log(`      New total: ${newTotal.toLocaleString()} plants`);
      console.log(`      Slots: ${updatedSlots.length}`);
      
      // Update the slots in database
      const updateResult = await PlantSlot.updateOne(
        { 
          _id: plantSlot._id,
          'subtypeSlots.subtypeId': new mongoose.Types.ObjectId(subtypeId)
        },
        {
          $set: {
            'subtypeSlots.$.slots': updatedSlots
          }
        }
      );
      
      if (updateResult.modifiedCount > 0) {
        totalSlotsUpdated += updatedSlots.length;
        totalCapacityRedistributed += newTotal;
        console.log(`      ✅ Updated ${updatedSlots.length} slots`);
      } else {
        console.log(`      ❌ Failed to update slots`);
      }
    }
    
    console.log(`\n🎉 Fix completed for plant ${plantId}, subtype ${subtypeId}:`);
    console.log(`   Total slots updated: ${totalSlotsUpdated}`);
    console.log(`   Total capacity redistributed: ${totalCapacityRedistributed.toLocaleString()} plants`);
    
  } catch (error) {
    console.error(`❌ Error fixing slots for plant ${plantId}, subtype ${subtypeId}:`, error);
  }
};

// Main function to fix all slots
const fixAllSlots = async () => {
  try {
    console.log('🚀 Starting slot capacity redistribution...');
    
    // Get all plants
    const plants = await PlantCms.find({});
    console.log(`📋 Found ${plants.length} plants`);
    
    for (const plant of plants) {
      console.log(`\n🌱 Processing plant: ${plant.name}`);
      
      for (const subtype of plant.subtypes) {
        console.log(`   📦 Processing subtype: ${subtype.name}`);
        
        // For now, use a default capacity - you can customize this per plant/subtype
        const defaultCapacity = 212500; // This should be customized based on your business logic
        
        await fixSlotsForPlantSubtype(plant._id, subtype._id, defaultCapacity);
      }
    }
    
    console.log('\n✅ All slots have been processed!');
    
  } catch (error) {
    console.error('❌ Error in main fix process:', error);
  }
};

// Function to fix specific plant/subtype (for targeted fixes)
const fixSpecificSlots = async (plantName, subtypeName, totalCapacity) => {
  try {
    console.log(`🎯 Fixing specific slots for ${plantName} - ${subtypeName}`);
    
    // Find the plant
    const plant = await PlantCms.findOne({ name: { $regex: new RegExp(`^${plantName}$`, 'i') } });
    if (!plant) {
      console.log(`❌ Plant '${plantName}' not found`);
      return;
    }
    
    // Find the subtype
    const subtype = plant.subtypes.find(st => 
      st.name && st.name.toLowerCase().includes(subtypeName.toLowerCase())
    );
    if (!subtype) {
      console.log(`❌ Subtype '${subtypeName}' not found for plant '${plantName}'`);
      console.log('Available subtypes:');
      plant.subtypes.forEach(st => console.log(`  - ${st.name}`));
      return;
    }
    
    await fixSlotsForPlantSubtype(plant._id, subtype._id, totalCapacity);
    
  } catch (error) {
    console.error('❌ Error fixing specific slots:', error);
  }
};

// Main execution
const main = async () => {
  try {
    await connectDB();
    
    // Check command line arguments
    const args = process.argv.slice(2);
    
    if (args.length >= 3) {
      // Specific plant/subtype fix
      const plantName = args[0];
      const subtypeName = args[1];
      const totalCapacity = parseInt(args[2]) || 212500;
      
      await fixSpecificSlots(plantName, subtypeName, totalCapacity);
    } else {
      // Fix all slots
      await fixAllSlots();
    }
    
    console.log('\n✅ Script completed successfully!');
  } catch (error) {
    console.error('❌ Script failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
    process.exit(0);
  }
};

// Run the script
main();
