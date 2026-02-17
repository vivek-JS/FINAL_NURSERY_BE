import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGO_URL or MONGODB_URI environment variable is required.');
    }
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB\n');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
};

const resetAllSlotsToZero = async () => {
  try {
    await connectDB();
    
    // Import models
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    console.log('📊 Resetting all slot data to zero...\n');
    
    // Get all plant slots
    const plantSlots = await PlantSlot.find({});
    
    let totalSlotsReset = 0;
    let totalDocumentsUpdated = 0;
    
    for (const plantSlot of plantSlots) {
      let documentModified = false;
      
      for (const subtypeSlot of plantSlot.subtypeSlots || []) {
        for (const slot of subtypeSlot.slots || []) {
          // Reset all numeric fields to 0
          slot.totalPlants = 0;
          slot.availablePlants = 0;
          slot.totalBookedPlants = 0;
          slot.plantsSowed = 0;
          slot.officeSowed = 0;
          slot.primarySowed = 0;
          slot.buffer = 0;
          slot.effectiveBuffer = 0;
          slot.bufferAmount = 0;
          slot.originalTotalPlants = 0;
          slot.bufferAdjustedCapacity = 0;
          slot.plantReadyDays = 0;
          slot.reminderBeforePlantReadyDays = 0;
          
          // Clear date fields
          slot.sowingDate = null;
          slot.plantReadyDate = null;
          slot.sowingCompletedDate = null;
          
          // Clear boolean flags
          slot.sowingCompleted = false;
          slot.isOverflow = false;
          slot.overflow = false;
          slot.status = false;
          
          // Clear arrays
          slot.sowingInProgress = [];
          slot.linkedSowingRequests = [];
          slot.gapCovered = [];
          slot.gapFullyCovered = false;
          slot.orders = [];
          slot.slotTrail = [];
          
          // Clear excessive sowing
          if (slot.excessiveSowing) {
            slot.excessiveSowing.packets = 0;
            slot.excessiveSowing.plants = 0;
          }
          
          totalSlotsReset++;
          documentModified = true;
        }
      }
      
      if (documentModified) {
        plantSlot.markModified('subtypeSlots');
        await plantSlot.save();
        totalDocumentsUpdated++;
      }
    }
    
    console.log(`✅ Reset complete:`);
    console.log(`   - Total Slots Reset: ${totalSlotsReset}`);
    console.log(`   - Documents Updated: ${totalDocumentsUpdated}`);
    console.log(`\n📊 Fields reset to zero:`);
    console.log(`   - totalPlants, availablePlants, totalBookedPlants`);
    console.log(`   - plantsSowed, officeSowed, primarySowed`);
    console.log(`   - buffer, effectiveBuffer, bufferAmount`);
    console.log(`   - All date fields cleared`);
    console.log(`   - All arrays cleared (sowingInProgress, orders, etc.)`);
    console.log(`   - All boolean flags reset`);
    
    // Verify
    console.log('\n🔍 Verifying reset...\n');
    const verifySlots = await PlantSlot.find({}).lean();
    let slotsWithData = 0;
    
    for (const ps of verifySlots) {
      for (const st of ps.subtypeSlots || []) {
        for (const slot of st.slots || []) {
          const hasData = 
            (slot.totalPlants && slot.totalPlants > 0) ||
            (slot.availablePlants && slot.availablePlants > 0) ||
            (slot.totalBookedPlants && slot.totalBookedPlants > 0) ||
            (slot.plantsSowed && slot.plantsSowed > 0) ||
            (slot.officeSowed && slot.officeSowed > 0) ||
            (slot.primarySowed && slot.primarySowed > 0) ||
            slot.sowingDate ||
            (slot.sowingInProgress && slot.sowingInProgress.length > 0);
          
          if (hasData) {
            slotsWithData++;
          }
        }
      }
    }
    
    if (slotsWithData === 0) {
      console.log('✅ Verification successful: All slots have been reset to zero!');
    } else {
      console.log(`⚠️  Warning: ${slotsWithData} slot(s) still have data`);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
};

resetAllSlotsToZero();






