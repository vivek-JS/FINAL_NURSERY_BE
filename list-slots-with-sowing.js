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

const listSlotsWithSowing = async () => {
  try {
    await connectDB();
    
    // Import models
    const Sowing = (await import('./models/sowing.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    const PlantCms = (await import('./models/plantCms.model.js')).default;
    
    console.log('📊 Finding slots with sowing data...\n');
    
    // Get all plant slots
    const plantSlots = await PlantSlot.find({}).lean();
    
    const slotsWithSowing = [];
    
    for (const plantSlot of plantSlots) {
      for (const subtypeSlot of plantSlot.subtypeSlots || []) {
        for (const slot of subtypeSlot.slots || []) {
          const hasSowingData = 
            (slot.plantsSowed && slot.plantsSowed > 0) ||
            (slot.officeSowed && slot.officeSowed > 0) ||
            (slot.primarySowed && slot.primarySowed > 0) ||
            slot.sowingDate ||
            slot.plantReadyDate;
          
          if (hasSowingData) {
            // Get plant name
            let plantName = 'Unknown';
            if (plantSlot.plantId) {
              const plant = await PlantCms.findById(plantSlot.plantId).select('name').lean();
              plantName = plant?.name || 'Unknown';
            }
            
            // Count sowing records
            const sowingCount = await Sowing.countDocuments({ slotId: slot._id });
            
            slotsWithSowing.push({
              slotId: slot._id.toString(),
              plantName,
              plantId: plantSlot.plantId?.toString(),
              year: plantSlot.year,
              startDay: slot.startDay,
              endDay: slot.endDay,
              plantsSowed: slot.plantsSowed || 0,
              officeSowed: slot.officeSowed || 0,
              primarySowed: slot.primarySowed || 0,
              sowingDate: slot.sowingDate || null,
              plantReadyDate: slot.plantReadyDate || null,
              sowingRecordsCount: sowingCount
            });
          }
        }
      }
    }
    
    if (slotsWithSowing.length === 0) {
      console.log('ℹ️  No slots with sowing data found.\n');
    } else {
      console.log(`Found ${slotsWithSowing.length} slot(s) with sowing data:\n`);
      console.log('─'.repeat(120));
      console.log(
        'Slot ID'.padEnd(28) +
        'Plant'.padEnd(20) +
        'Date Range'.padEnd(18) +
        'Plants'.padEnd(10) +
        'Office'.padEnd(10) +
        'Primary'.padEnd(10) +
        'Sowing Date'.padEnd(15) +
        'Records'
      );
      console.log('─'.repeat(120));
      
      slotsWithSowing.forEach(slot => {
        const dateRange = `${slot.startDay || 'N/A'} to ${slot.endDay || 'N/A'}`;
        console.log(
          slot.slotId.padEnd(28) +
          slot.plantName.padEnd(20) +
          dateRange.padEnd(18) +
          String(slot.plantsSowed).padEnd(10) +
          String(slot.officeSowed).padEnd(10) +
          String(slot.primarySowed).padEnd(10) +
          (slot.sowingDate || 'N/A').padEnd(15) +
          slot.sowingRecordsCount
        );
      });
      
      console.log('─'.repeat(120));
      console.log(`\n💡 To clear sowing data from a slot, run:`);
      console.log(`   node clear-slot-sowing-data.js <slotId>\n`);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  }
};

listSlotsWithSowing();


