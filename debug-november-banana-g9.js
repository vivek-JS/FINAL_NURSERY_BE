// Debug script to check November slot for Banana G-9
import dotenv from "dotenv";
dotenv.config();

import mongoose from 'mongoose';
import PlantCms from './models/plantCms.model.js';
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

// Debug November slot for Banana G-9
const debugNovemberBananaG9 = async () => {
  try {
    console.log('🔍 Debugging November slot for Banana G-9...\n');
    
    // Find Banana plant
    const plant = await PlantCms.findOne({ name: { $regex: /^Banana$/i } });
    if (!plant) {
      console.log('❌ Banana plant not found');
      return;
    }
    
    console.log(`🌱 Found plant: ${plant.name} (ID: ${plant._id})`);
    
    // Find G-9 subtype
    const g9Subtype = plant.subtypes.find(sub => 
      sub.name && sub.name.toLowerCase().includes('g-9')
    );
    if (!g9Subtype) {
      console.log('❌ G-9 subtype not found');
      console.log('Available subtypes:');
      plant.subtypes.forEach(sub => console.log(`  - ${sub.name}`));
      return;
    }
    
    console.log(`📦 Found subtype: ${g9Subtype.name} (ID: ${g9Subtype._id})`);
    
    // Find slots for 2025
    const plantSlot = await PlantSlot.findOne({ 
      plantId: plant._id, 
      year: 2025 
    });
    
    if (!plantSlot) {
      console.log('❌ No slots found for Banana in 2025');
      return;
    }
    
    console.log(`📅 Found plant slot document for year: ${plantSlot.year}`);
    
    // Find the G-9 subtype slot
    const subtypeSlot = plantSlot.subtypeSlots.find(
      s => s.subtypeId.toString() === g9Subtype._id.toString()
    );
    
    if (!subtypeSlot) {
      console.log('❌ No G-9 subtype slot found');
      console.log('Available subtypes in slots:');
      plantSlot.subtypeSlots.forEach(ss => {
        console.log(`  - ${ss.subtypeName} (ID: ${ss.subtypeId})`);
      });
      return;
    }
    
    console.log(`📋 Found G-9 subtype slot with ${subtypeSlot.slots.length} total slots`);
    
    // Filter November slots
    const novemberSlots = subtypeSlot.slots.filter(slot => 
      slot.month && slot.month.toLowerCase() === 'november'
    );
    
    console.log(`\n🍂 November slots (${novemberSlots.length} found):`);
    console.log('=' .repeat(80));
    
    novemberSlots.forEach((slot, index) => {
      console.log(`\nSlot ${index + 1}:`);
      console.log(`  ID: ${slot._id}`);
      console.log(`  Period: ${slot.startDay} to ${slot.endDay}`);
      console.log(`  Month: ${slot.month}`);
      console.log(`  Total Plants: ${slot.totalPlants?.toLocaleString() || 'N/A'}`);
      console.log(`  Total Booked Plants: ${slot.totalBookedPlants?.toLocaleString() || 'N/A'}`);
      console.log(`  Available Plants: ${slot.availablePlants?.toLocaleString() || 'N/A'}`);
      console.log(`  Buffer: ${slot.buffer || 0}%`);
      console.log(`  Effective Buffer: ${slot.effectiveBuffer || 0}%`);
      console.log(`  Buffer Adjusted Capacity: ${slot.bufferAdjustedCapacity?.toLocaleString() || 'N/A'}`);
      console.log(`  Buffer Amount: ${slot.bufferAmount?.toLocaleString() || 'N/A'}`);
      console.log(`  Original Total Plants: ${slot.originalTotalPlants?.toLocaleString() || 'N/A'}`);
      console.log(`  Is Overflow: ${slot.isOverflow || false}`);
      console.log(`  Orders Count: ${slot.orders?.length || 0}`);
      
      if (slot.orders && slot.orders.length > 0) {
        console.log(`  Orders:`);
        slot.orders.forEach((order, orderIndex) => {
          console.log(`    ${orderIndex + 1}. Order ID: ${order.orderId}, Plants: ${order.numberOfPlants}, Status: ${order.orderStatus}`);
        });
      }
    });
    
    // Summary
    const totalCapacity = novemberSlots.reduce((sum, slot) => sum + (slot.totalPlants || 0), 0);
    const totalBooked = novemberSlots.reduce((sum, slot) => sum + (slot.totalBookedPlants || 0), 0);
    const totalAvailable = novemberSlots.reduce((sum, slot) => sum + (slot.availablePlants || 0), 0);
    
    console.log('\n📊 November Summary:');
    console.log('=' .repeat(40));
    console.log(`Total Slots: ${novemberSlots.length}`);
    console.log(`Total Capacity: ${totalCapacity.toLocaleString()} plants`);
    console.log(`Total Booked: ${totalBooked.toLocaleString()} plants`);
    console.log(`Total Available: ${totalAvailable.toLocaleString()} plants`);
    console.log(`Overflow: ${totalBooked > totalCapacity ? 'YES' : 'NO'}`);
    
  } catch (error) {
    console.error('❌ Error debugging November slots:', error);
  }
};

// Main execution
const main = async () => {
  try {
    await connectDB();
    await debugNovemberBananaG9();
    console.log('\n✅ Debug completed!');
  } catch (error) {
    console.error('❌ Debug failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
    process.exit(0);
  }
};

// Run the script
main();
