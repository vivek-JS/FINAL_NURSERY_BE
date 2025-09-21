// Script to fix availablePlants values in database to be totalPlants - totalBookedPlants
import dotenv from "dotenv";
dotenv.config();

import mongoose from 'mongoose';
import PlantSlot from './models/slots.model.js';

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

// Fix availablePlants for all slots
const fixAvailablePlants = async () => {
  try {
    console.log('🔧 Fixing availablePlants values in database...\n');
    
    // Get all plant slots
    const plantSlots = await PlantSlot.find({});
    console.log(`📋 Found ${plantSlots.length} plant slot documents`);
    
    let totalSlotsUpdated = 0;
    let totalSlotsProcessed = 0;
    
    for (const plantSlot of plantSlots) {
      console.log(`\n🌱 Processing year ${plantSlot.year}...`);
      
      for (const subtypeSlot of plantSlot.subtypeSlots) {
        console.log(`   📦 Processing subtype: ${subtypeSlot.subtypeName}`);
        
        for (const slot of subtypeSlot.slots) {
          totalSlotsProcessed++;
          
          // Calculate correct availablePlants
          const totalPlants = slot.totalPlants || 0;
          const totalBookedPlants = slot.totalBookedPlants || 0;
          const correctAvailablePlants = Math.max(0, totalPlants - totalBookedPlants);
          
          // Only update if the value is different
          if (slot.availablePlants !== correctAvailablePlants) {
            // Update the slot in database
            const updateResult = await PlantSlot.updateOne(
              { 
                _id: plantSlot._id,
                'subtypeSlots.subtypeId': subtypeSlot.subtypeId,
                'subtypeSlots.slots._id': slot._id
              },
              {
                $set: {
                  'subtypeSlots.$.slots.$[slotElem].availablePlants': correctAvailablePlants
                }
              },
              {
                arrayFilters: [{ 'slotElem._id': slot._id }]
              }
            );
            
            if (updateResult.modifiedCount > 0) {
              totalSlotsUpdated++;
              console.log(`      ✅ Slot ${slot.startDay}-${slot.endDay}: ${slot.availablePlants} → ${correctAvailablePlants}`);
            } else {
              console.log(`      ❌ Failed to update slot ${slot.startDay}-${slot.endDay}`);
            }
          } else {
            console.log(`      ✓ Slot ${slot.startDay}-${slot.endDay}: Already correct (${correctAvailablePlants})`);
          }
        }
      }
    }
    
    console.log(`\n🎉 Fix completed!`);
    console.log(`   Total slots processed: ${totalSlotsProcessed}`);
    console.log(`   Total slots updated: ${totalSlotsUpdated}`);
    
  } catch (error) {
    console.error('❌ Error fixing availablePlants:', error);
  }
};

// Main execution
const main = async () => {
  try {
    await connectDB();
    await fixAvailablePlants();
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
