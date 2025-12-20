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
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
};

const clearSlotSowingData = async (slotId) => {
  try {
    await connectDB();
    
    // Import models
    const Sowing = (await import('./models/sowing.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    if (!slotId) {
      console.error('❌ Error: slotId is required');
      console.log('\nUsage: node clear-slot-sowing-data.js <slotId>');
      console.log('Example: node clear-slot-sowing-data.js 507f1f77bcf86cd799439011');
      await mongoose.connection.close();
      process.exit(1);
    }

    // Validate slotId format
    if (!mongoose.Types.ObjectId.isValid(slotId)) {
      console.error(`❌ Error: Invalid slotId format: ${slotId}`);
      await mongoose.connection.close();
      process.exit(1);
    }

    const slotObjectId = new mongoose.Types.ObjectId(slotId);
    
    console.log(`\n📊 Clearing sowing data for slot: ${slotId}\n`);
    
    // Check if slot exists
    const slotDoc = await PlantSlot.findOne(
      { "subtypeSlots.slots._id": slotObjectId }
    ).lean();
    
    if (!slotDoc) {
      console.error(`❌ Error: Slot with ID ${slotId} not found`);
      await mongoose.connection.close();
      process.exit(1);
    }

    // Find the specific slot details
    let targetSlot = null;
    let targetSubtype = null;
    let plantSlotDoc = await PlantSlot.findOne(
      { "subtypeSlots.slots._id": slotObjectId }
    );

    for (const subtype of plantSlotDoc.subtypeSlots) {
      const slot = subtype.slots.find(s => s._id.toString() === slotId);
      if (slot) {
        targetSlot = slot;
        targetSubtype = subtype;
        break;
      }
    }

    if (!targetSlot) {
      console.error(`❌ Error: Could not find slot in document structure`);
      await mongoose.connection.close();
      process.exit(1);
    }

    console.log(`📦 Slot Details:`);
    console.log(`   - Start Day: ${targetSlot.startDay || 'N/A'}`);
    console.log(`   - End Day: ${targetSlot.endDay || 'N/A'}`);
    console.log(`   - Plants Sowed: ${targetSlot.plantsSowed || 0}`);
    console.log(`   - Office Sowed: ${targetSlot.officeSowed || 0}`);
    console.log(`   - Primary Sowed: ${targetSlot.primarySowed || 0}`);
    console.log(`   - Sowing Date: ${targetSlot.sowingDate || 'N/A'}`);
    console.log(`   - Plant Ready Date: ${targetSlot.plantReadyDate || 'N/A'}`);
    console.log(`   - Sowing In Progress: ${targetSlot.sowingInProgress?.length || 0} entries`);
    console.log(`   - Sowing Completed: ${targetSlot.sowingCompleted || false}`);
    console.log(`   - Linked Sowing Requests: ${targetSlot.linkedSowingRequests?.length || 0}\n`);

    // Count sowings before deletion
    const sowingsCount = await Sowing.countDocuments({ slotId: slotObjectId });
    console.log(`🌱 Sowing Records for this slot: ${sowingsCount} documents\n`);

    const hasSowingData = sowingsCount > 0 || 
        (targetSlot.plantsSowed && targetSlot.plantsSowed > 0) ||
        (targetSlot.officeSowed && targetSlot.officeSowed > 0) ||
        (targetSlot.primarySowed && targetSlot.primarySowed > 0) ||
        targetSlot.sowingDate ||
        (targetSlot.sowingInProgress && targetSlot.sowingInProgress.length > 0) ||
        targetSlot.sowingCompleted ||
        (targetSlot.linkedSowingRequests && targetSlot.linkedSowingRequests.length > 0);

    if (!hasSowingData) {
      console.log('ℹ️  No sowing data found for this slot. Nothing to clear.');
      await mongoose.connection.close();
      return;
    }

    // Delete all sowing records for this slot
    console.log('🗑️  Deleting sowing records...');
    const sowingResult = await Sowing.deleteMany({ slotId: slotObjectId });
    console.log(`✅ Deleted ${sowingResult.deletedCount} sowing record(s)\n`);

    // Reset slot sowing fields using arrayFilters
    console.log('🔄 Resetting slot sowing fields...');
    
    const updateResult = await PlantSlot.updateOne(
      { "subtypeSlots.slots._id": slotObjectId },
      {
        $set: {
          "subtypeSlots.$[subtypeSlot].slots.$[slot].plantsSowed": 0,
          "subtypeSlots.$[subtypeSlot].slots.$[slot].officeSowed": 0,
          "subtypeSlots.$[subtypeSlot].slots.$[slot].primarySowed": 0,
          "subtypeSlots.$[subtypeSlot].slots.$[slot].sowingDate": null,
          "subtypeSlots.$[subtypeSlot].slots.$[slot].plantReadyDate": null,
          "subtypeSlots.$[subtypeSlot].slots.$[slot].reminderBeforePlantReadyDays": 0,
          "subtypeSlots.$[subtypeSlot].slots.$[slot].sowingInProgress": [],
          "subtypeSlots.$[subtypeSlot].slots.$[slot].sowingCompleted": false,
          "subtypeSlots.$[subtypeSlot].slots.$[slot].sowingCompletedDate": null,
          "subtypeSlots.$[subtypeSlot].slots.$[slot].linkedSowingRequests": [],
          "subtypeSlots.$[subtypeSlot].slots.$[slot].excessiveSowing.packets": 0,
          "subtypeSlots.$[subtypeSlot].slots.$[slot].excessiveSowing.plants": 0,
        }
      },
      {
        arrayFilters: [
          { "subtypeSlot.slots._id": slotObjectId },
          { "slot._id": slotObjectId }
        ]
      }
    );

    if (updateResult.matchedCount === 0) {
      console.error('❌ Error: Could not find slot to update');
      await mongoose.connection.close();
      process.exit(1);
    }

    console.log(`✅ Slot updated: ${updateResult.modifiedCount > 0 ? 'Modified' : 'No changes needed'}\n`);

    // Verify cleanup
    console.log('🔍 Verifying cleanup...\n');
    const remainingSowings = await Sowing.countDocuments({ slotId: slotObjectId });
    
    // Reload slot to check
    const updatedSlotDoc = await PlantSlot.findOne(
      { "subtypeSlots.slots._id": slotObjectId }
    ).lean();
    
    let updatedSlot = null;
    for (const subtype of updatedSlotDoc.subtypeSlots) {
      const slot = subtype.slots.find(s => s._id.toString() === slotId);
      if (slot) {
        updatedSlot = slot;
        break;
      }
    }

    const isFullyCleared = remainingSowings === 0 && 
        (!updatedSlot.plantsSowed || updatedSlot.plantsSowed === 0) &&
        (!updatedSlot.officeSowed || updatedSlot.officeSowed === 0) &&
        (!updatedSlot.primarySowed || updatedSlot.primarySowed === 0) &&
        !updatedSlot.sowingDate &&
        (!updatedSlot.sowingInProgress || updatedSlot.sowingInProgress.length === 0) &&
        (!updatedSlot.sowingCompleted || updatedSlot.sowingCompleted === false) &&
        (!updatedSlot.linkedSowingRequests || updatedSlot.linkedSowingRequests.length === 0);

    if (isFullyCleared) {
      console.log('✅ Verification successful: All sowing data has been cleared from the slot.');
      console.log(`\n📊 Final Status:`);
      console.log(`   - Sowing Records: ${remainingSowings}`);
      console.log(`   - Plants Sowed: ${updatedSlot.plantsSowed || 0}`);
      console.log(`   - Office Sowed: ${updatedSlot.officeSowed || 0}`);
      console.log(`   - Primary Sowed: ${updatedSlot.primarySowed || 0}`);
      console.log(`   - Sowing Date: ${updatedSlot.sowingDate || 'null'}`);
      console.log(`   - Plant Ready Date: ${updatedSlot.plantReadyDate || 'null'}`);
      console.log(`   - Sowing In Progress: ${updatedSlot.sowingInProgress?.length || 0} entries`);
      console.log(`   - Sowing Completed: ${updatedSlot.sowingCompleted || false}`);
      console.log(`   - Linked Requests: ${updatedSlot.linkedSowingRequests?.length || 0}`);
    } else {
      console.log(`⚠️  Warning: Some data may still exist:`);
      console.log(`   - Remaining Sowings: ${remainingSowings}`);
      console.log(`   - Plants Sowed: ${updatedSlot?.plantsSowed || 0}`);
      console.log(`   - Office Sowed: ${updatedSlot?.officeSowed || 0}`);
      console.log(`   - Primary Sowed: ${updatedSlot?.primarySowed || 0}`);
      console.log(`   - Sowing In Progress: ${updatedSlot?.sowingInProgress?.length || 0} entries`);
      console.log(`   - Sowing Completed: ${updatedSlot?.sowingCompleted || false}`);
      console.log(`   - Linked Requests: ${updatedSlot?.linkedSowingRequests?.length || 0}`);
    }

    console.log('\n✅ Slot sowing data cleared successfully!\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  }
};

// Get slotId from command line arguments
const slotId = process.argv[2];

clearSlotSowingData(slotId);

