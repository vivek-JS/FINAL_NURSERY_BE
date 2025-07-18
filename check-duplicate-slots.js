import mongoose from 'mongoose';
import dotenv from 'dotenv';
import PlantCms from './models/plantCms.model.js';
import PlantSlot from './models/slots.model.js';

dotenv.config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

const checkDuplicateSlots = async () => {
  try {
    await connectDB();

    const allPlants = await PlantCms.find({});
    const allSlots = await PlantSlot.find({});

    console.log('\n🔍 ANALYZING DUPLICATE SLOTS');
    console.log('=============================');
    
    console.log(`\n📋 Total Plants: ${allPlants.length}`);
    console.log(`📋 Total Slot Configurations: ${allSlots.length}`);

    // Group slots by plant and year to identify duplicates
    const slotGroups = {};
    
    allSlots.forEach(slot => {
      const key = `${slot.plantId}_${slot.year}`;
      if (!slotGroups[key]) {
        slotGroups[key] = [];
      }
      slotGroups[key].push(slot);
    });

    console.log('\n📊 SLOT GROUPING ANALYSIS:');
    console.log('==========================');
    
    Object.keys(slotGroups).forEach(key => {
      const [plantId, year] = key.split('_');
      const plant = allPlants.find(p => p._id.toString() === plantId);
      const slots = slotGroups[key];
      
      console.log(`\n${plant?.name || 'Unknown Plant'} - Year ${year}:`);
      console.log(`  Configurations: ${slots.length}`);
      
      if (slots.length > 1) {
        console.log(`  ⚠️ DUPLICATE DETECTED!`);
        slots.forEach((slot, index) => {
          console.log(`    Config ${index + 1}: ${slot.subtypeSlots.length} subtypes`);
          slot.subtypeSlots.forEach(subtypeSlot => {
            console.log(`      - ${subtypeSlot.subtypeName}: ${subtypeSlot.slots.length} slots`);
          });
        });
      } else {
        slots.forEach(slot => {
          console.log(`  ✅ Single configuration: ${slot.subtypeSlots.length} subtypes`);
          slot.subtypeSlots.forEach(subtypeSlot => {
            console.log(`    - ${subtypeSlot.subtypeName}: ${subtypeSlot.slots.length} slots`);
          });
        });
      }
    });

    // Show detailed slot information
    console.log('\n📋 DETAILED SLOT INFORMATION:');
    console.log('=============================');
    
    allSlots.forEach((slot, index) => {
      const plant = allPlants.find(p => p._id.toString() === slot.plantId.toString());
      console.log(`\nSlot Config ${index + 1}:`);
      console.log(`  Plant: ${plant?.name}`);
      console.log(`  Year: ${slot.year}`);
      console.log(`  Subtypes: ${slot.subtypeSlots.length}`);
      console.log(`  ID: ${slot._id}`);
      
      slot.subtypeSlots.forEach(subtypeSlot => {
        console.log(`    - ${subtypeSlot.subtypeName}: ${subtypeSlot.slots.length} slots`);
        if (subtypeSlot.slots.length > 0) {
          console.log(`      First slot: ${subtypeSlot.slots[0].startDay} to ${subtypeSlot.slots[0].endDay}`);
          console.log(`      Capacity: ${subtypeSlot.slots[0].totalPlants.toLocaleString()}`);
        }
      });
    });

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 MongoDB disconnected');
  }
};

checkDuplicateSlots(); 