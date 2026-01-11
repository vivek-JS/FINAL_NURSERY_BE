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

const clearAllSowingFromSlots = async () => {
  try {
    await connectDB();
    
    // Import models
    const Sowing = (await import('./models/sowing.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    console.log('📊 Clearing all sowing data from slots...\n');
    
    // First, delete all sowing records
    console.log('🗑️  Deleting all sowing records...');
    const sowingResult = await Sowing.deleteMany({});
    console.log(`✅ Deleted ${sowingResult.deletedCount} sowing record(s)\n`);
    
    // Get all plant slots
    const plantSlots = await PlantSlot.find({});
    
    let totalSlotsCleared = 0;
    let totalDocumentsUpdated = 0;
    
    for (const plantSlot of plantSlots) {
      let documentModified = false;
      
      for (const subtypeSlot of plantSlot.subtypeSlots || []) {
        for (const slot of subtypeSlot.slots || []) {
          // Check if slot has any sowing data
          const hasSowingData = 
            (slot.plantsSowed && slot.plantsSowed > 0) ||
            (slot.officeSowed && slot.officeSowed > 0) ||
            (slot.primarySowed && slot.primarySowed > 0) ||
            slot.sowingDate ||
            slot.plantReadyDate ||
            (slot.sowingInProgress && slot.sowingInProgress.length > 0) ||
            slot.sowingCompleted ||
            (slot.linkedSowingRequests && slot.linkedSowingRequests.length > 0);
          
          if (hasSowingData) {
            // Reset only sowing-related fields
            slot.plantsSowed = 0;
            slot.officeSowed = 0;
            slot.primarySowed = 0;
            slot.sowingDate = null;
            slot.plantReadyDate = null;
            slot.sowingCompletedDate = null;
            slot.reminderBeforePlantReadyDays = 0;
            slot.sowingCompleted = false;
            slot.sowingInProgress = [];
            slot.linkedSowingRequests = [];
            
            // Clear excessive sowing (if it was from sowing)
            if (slot.excessiveSowing) {
              slot.excessiveSowing.packets = 0;
              slot.excessiveSowing.plants = 0;
            }
            
            // Clear gap coverage related to sowing
            slot.gapCovered = [];
            slot.gapFullyCovered = false;
            
            totalSlotsCleared++;
            documentModified = true;
          }
        }
      }
      
      if (documentModified) {
        plantSlot.markModified('subtypeSlots');
        await plantSlot.save();
        totalDocumentsUpdated++;
      }
    }
    
    console.log(`✅ Sowing data cleared:`);
    console.log(`   - Sowing Records Deleted: ${sowingResult.deletedCount}`);
    console.log(`   - Slots Cleared: ${totalSlotsCleared}`);
    console.log(`   - Documents Updated: ${totalDocumentsUpdated}`);
    console.log(`\n📊 Sowing fields cleared:`);
    console.log(`   - plantsSowed, officeSowed, primarySowed → 0`);
    console.log(`   - sowingDate, plantReadyDate → null`);
    console.log(`   - sowingInProgress, linkedSowingRequests → []`);
    console.log(`   - sowingCompleted → false`);
    console.log(`   - excessiveSowing → 0`);
    console.log(`   - gapCovered → []`);
    
    // Verify
    console.log('\n🔍 Verifying cleanup...\n');
    const verifySlots = await PlantSlot.find({}).lean();
    let slotsWithSowing = 0;
    
    for (const ps of verifySlots) {
      for (const st of ps.subtypeSlots || []) {
        for (const slot of st.slots || []) {
          const hasSowing = 
            (slot.plantsSowed && slot.plantsSowed > 0) ||
            (slot.officeSowed && slot.officeSowed > 0) ||
            (slot.primarySowed && slot.primarySowed > 0) ||
            slot.sowingDate ||
            slot.plantReadyDate ||
            (slot.sowingInProgress && slot.sowingInProgress.length > 0) ||
            slot.sowingCompleted ||
            (slot.linkedSowingRequests && slot.linkedSowingRequests.length > 0);
          
          if (hasSowing) {
            slotsWithSowing++;
          }
        }
      }
    }
    
    const remainingSowings = await Sowing.countDocuments({});
    
    if (remainingSowings === 0 && slotsWithSowing === 0) {
      console.log('✅ Verification successful: All sowing data has been cleared!');
    } else {
      console.log(`⚠️  Warning:`);
      console.log(`   - Remaining Sowing Records: ${remainingSowings}`);
      console.log(`   - Slots with Sowing Data: ${slotsWithSowing}`);
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

clearAllSowingFromSlots();





