// Script to update Banana G-9 slots from September to December 2025
// Total capacity: 212,500 plants

import dotenv from "dotenv";
dotenv.config();

import mongoose from 'mongoose';
import PlantCms from './models/plantCms.model.js';
import PlantSlot from './models/slots.model.js';
import { updateSlotBufferCalculations } from './utility/slotBufferUpdater.js';

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

// Find Banana G-9 plant
const findBananaG9Plant = async () => {
  try {
    // Only look for 'Banana'
    const plant = await PlantCms.findOne({ name: { $regex: /^Banana$/i } });
    if (!plant) {
      console.log('❌ Banana plant not found. Available plants:');
      const allPlants = await PlantCms.find({}, 'name');
      allPlants.forEach(p => console.log(`  - ${p.name}`));
      return null;
    }
    return plant;
  } catch (error) {
    console.error('❌ Error finding Banana plant:', error);
    return null;
  }
};

// Update slots for September to December 2025
const updateBananaG9Slots = async () => {
  try {
    const plant = await findBananaG9Plant();
    if (!plant) {
      console.log('❌ Cannot proceed without finding Banana plant');
      return;
    }

    // Find the G-9 subtype
    const g9Subtype = plant.subtypes.find(sub => sub.name && sub.name.toLowerCase().includes('g-9'));
    if (!g9Subtype) {
      console.log('❌ G-9 subtype not found for Banana. Available subtypes:');
      plant.subtypes.forEach(sub => console.log(`  - ${sub.name}`));
      return;
    }

    const year = 2025;
    const targetMonths = ['September', 'October', 'November', 'December'];
    const totalCapacity = 212500;
    
    // Calculate capacity per month (distribute evenly)
    const capacityPerMonth = Math.floor(totalCapacity / targetMonths.length);
    const remainingCapacity = totalCapacity % targetMonths.length;

    console.log(`\n📊 Updating Banana G-9 slots for ${year}:`);
    console.log(`   Total capacity: ${totalCapacity.toLocaleString()} plants`);
    console.log(`   Target months: ${targetMonths.join(', ')}`);
    console.log(`   Capacity per month: ${capacityPerMonth.toLocaleString()} plants`);

    // Find the plant slot document for 2025
    const plantSlot = await PlantSlot.findOne({ 
      plantId: plant._id, 
      year: year 
    });

    if (!plantSlot) {
      console.log(`❌ No slots found for ${plant.name} in ${year}`);
      return;
    }

    let totalUpdated = 0;
    let totalSlotsUpdated = 0;

    // Only update the G-9 subtype
    const subtypeSlot = plantSlot.subtypeSlots.find(
      s => s.subtypeId.toString() === g9Subtype._id.toString()
    );
    if (!subtypeSlot) {
      console.log('❌ No slot data found for G-9 subtype in slots collection.');
      return;
    }

    // Group slots by month
    const slotsByMonth = {};
    subtypeSlot.slots.forEach(slot => {
      if (!slotsByMonth[slot.month]) {
        slotsByMonth[slot.month] = [];
      }
      slotsByMonth[slot.month].push(slot);
    });

    // Update target months
    for (let i = 0; i < targetMonths.length; i++) {
      const month = targetMonths[i];
      const monthSlots = slotsByMonth[month];
      
      if (!monthSlots || monthSlots.length === 0) {
        console.log(`   ⚠️  No slots found for ${month}`);
        continue;
      }

      // Each slot gets the full capacity
      const slotCapacity = totalCapacity;

      console.log(`   📅 ${month}: ${slotCapacity.toLocaleString()} plants per slot, ${monthSlots.length} slots`);

      // Update each slot in this month
      for (let j = 0; j < monthSlots.length; j++) {
        const slot = monthSlots[j];

        // Update the slot
        const updateResult = await PlantSlot.updateOne(
          { 
            _id: plantSlot._id,
            'subtypeSlots.subtypeId': subtypeSlot.subtypeId,
            'subtypeSlots.slots._id': slot._id
          },
          {
            $set: {
              'subtypeSlots.$.slots.$[slotElem].totalPlants': slotCapacity,
              'subtypeSlots.$.slots.$[slotElem].originalTotalPlants': slotCapacity
            }
          },
          {
            arrayFilters: [{ 'slotElem._id': slot._id }]
          }
        );

        if (updateResult.modifiedCount > 0) {
          // Update buffer calculations
          await updateSlotBufferCalculations(
            slot._id,
            slotCapacity,
            slot.totalBookedPlants || 0,
            slot.buffer || 0
          );

          totalUpdated += slotCapacity;
          totalSlotsUpdated++;
          
          console.log(`      ✅ Slot ${slot.startDay}-${slot.endDay}: ${slotCapacity.toLocaleString()} plants`);
        }
      }
    }

    console.log(`\n🎉 Update completed successfully!`);
    console.log(`   Total plants updated: ${totalUpdated.toLocaleString()}`);
    console.log(`   Total slots updated: ${totalSlotsUpdated}`);
    console.log(`   Target capacity: ${totalCapacity.toLocaleString()}`);

  } catch (error) {
    console.error('❌ Error updating Banana G-9 slots:', error);
  }
};

// Main execution
const main = async () => {
  try {
    await connectDB();
    await updateBananaG9Slots();
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