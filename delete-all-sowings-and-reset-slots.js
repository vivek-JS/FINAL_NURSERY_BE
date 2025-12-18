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

const deleteAllSowingsAndResetSlots = async () => {
  try {
    await connectDB();
    
    // Import models
    const Sowing = (await import('./models/sowing.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    console.log('\n📊 Counting sowings and slots before cleanup...\n');
    
    // Count sowings before deletion
    const sowingsCount = await Sowing.countDocuments({});
    
    // Count slots with sowing data
    const slotsWithSowing = await PlantSlot.countDocuments({
      $or: [
        { plantsSowed: { $gt: 0 } },
        { officeSowed: { $gt: 0 } },
        { primarySowed: { $gt: 0 } },
        { sowingDate: { $exists: true, $ne: null, $ne: '' } },
        { plantReadyDate: { $exists: true, $ne: null, $ne: '' } }
      ]
    });
    
    // Get breakdown by location type
    const officeSowings = await Sowing.countDocuments({ 
      $or: [
        { officeSowed: { $gt: 0 } },
        { sowingLocation: 'OFFICE' }
      ]
    });
    const primarySowings = await Sowing.countDocuments({ 
      $or: [
        { primarySowed: { $gt: 0 } },
        { sowingLocation: 'PRIMARY' }
      ]
    });
    
    console.log(`🌱 Total Sowing Records: ${sowingsCount} documents`);
    console.log(`   - Office Sowings: ${officeSowings}`);
    console.log(`   - Primary Sowings: ${primarySowings}`);
    console.log(`📦 Slots with Sowing Data: ${slotsWithSowing} slots\n`);
    
    if (sowingsCount === 0 && slotsWithSowing === 0) {
      console.log('ℹ️  No sowing records or slot sowing data found. Nothing to clean.');
      await mongoose.connection.close();
      return;
    }
    
    console.log('🗑️  Deleting all sowing records...\n');
    
    // Delete all sowings
    const sowingResult = await Sowing.deleteMany({});
    console.log(`✅ Sowing Records: Deleted ${sowingResult.deletedCount} documents`);
    
    console.log('\n🔄 Resetting sowing-related fields in slots...\n');
    
    // Reset all sowing-related fields in slots
    const slotUpdateResult = await PlantSlot.updateMany(
      {
        $or: [
          { plantsSowed: { $gt: 0 } },
          { officeSowed: { $gt: 0 } },
          { primarySowed: { $gt: 0 } },
          { sowingDate: { $exists: true, $ne: null, $ne: '' } },
          { plantReadyDate: { $exists: true, $ne: null, $ne: '' } }
        ]
      },
      {
        $set: {
          plantsSowed: 0,
          officeSowed: 0,
          primarySowed: 0,
          sowingDate: null,
          plantReadyDate: null,
          reminderBeforePlantReadyDays: 0
        }
      }
    );
    
    const slotsModified = slotUpdateResult?.modifiedCount || slotUpdateResult?.matchedCount || 0;
    console.log(`✅ Slots Updated: Reset sowing fields in ${slotsModified} slots`);
    
    const totalCleaned = sowingResult.deletedCount + slotsModified;
    
    console.log(`\n✅ Total cleaned:`);
    console.log(`   - Sowing Records Deleted: ${sowingResult.deletedCount}`);
    console.log(`   - Slots Reset: ${slotsModified}`);
    console.log(`   - Total Operations: ${totalCleaned}`);
    console.log('\n✅ All sowings and related slot data cleared successfully! (No other data was affected)\n');
    
    // Verify cleanup
    console.log('🔍 Verifying cleanup...\n');
    const remainingSowings = await Sowing.countDocuments({});
    const remainingSlotsWithSowing = await PlantSlot.countDocuments({
      $or: [
        { plantsSowed: { $gt: 0 } },
        { officeSowed: { $gt: 0 } },
        { primarySowed: { $gt: 0 } },
        { sowingDate: { $exists: true, $ne: null, $ne: '' } },
        { plantReadyDate: { $exists: true, $ne: null, $ne: '' } }
      ]
    });
    
    if (remainingSowings === 0 && remainingSlotsWithSowing === 0) {
      console.log('✅ Verification successful: All sowings and slot sowing data have been cleared.');
    } else {
      console.log(`⚠️  Warning: Some data may still exist:`);
      console.log(`   - Remaining Sowings: ${remainingSowings}`);
      console.log(`   - Slots with Sowing Data: ${remainingSlotsWithSowing}`);
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

deleteAllSowingsAndResetSlots();

