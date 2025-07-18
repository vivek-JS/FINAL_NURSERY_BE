import mongoose from 'mongoose';
import dotenv from 'dotenv';
import './models/plantCms.model.js';
import './models/slots.model.js';

// Load environment variables
dotenv.config();

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Clear empty slot documents
const clearEmptySlots = async () => {
  try {
    console.log('🗑️  Clearing empty slot documents...');
    
    // Get PlantSlot model
    const PlantSlot = mongoose.model('PlantSlot');
    
    // Find all slot documents
    const allSlots = await PlantSlot.find({});
    console.log(`📅 Found ${allSlots.length} slot documents`);
    
    let emptyCount = 0;
    let totalSlotsCount = 0;
    
    // Check each document
    for (const slotDoc of allSlots) {
      let hasSlots = false;
      
      // Check if any subtype has slots
      for (const subtypeSlot of slotDoc.subtypeSlots) {
        if (subtypeSlot.slots && subtypeSlot.slots.length > 0) {
          hasSlots = true;
          totalSlotsCount += subtypeSlot.slots.length;
          break;
        }
      }
      
      if (!hasSlots) {
        emptyCount++;
        console.log(`🗑️  Deleting empty slot document for plant ${slotDoc.plantId}, year ${slotDoc.year}`);
        await PlantSlot.findByIdAndDelete(slotDoc._id);
      }
    }
    
    console.log(`✅ Deleted ${emptyCount} empty slot documents`);
    console.log(`📊 Remaining slots in database: ${totalSlotsCount}`);
    
    // Verify deletion
    const remainingSlots = await PlantSlot.countDocuments();
    console.log(`📅 Remaining slot documents: ${remainingSlots}`);
    
  } catch (error) {
    console.error('❌ Error clearing empty slots:', error);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
  }
};

// Run the script
connectDB().then(() => {
  clearEmptySlots().then(() => {
    console.log('🏁 Script completed');
    process.exit(0);
  });
}); 