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

// Check slots in database
const checkSlots = async () => {
  try {
    console.log('🔍 Checking slots in database...');
    
    // Get PlantSlot model
    const PlantSlot = mongoose.model('PlantSlot');
    const PlantCms = mongoose.model('PlantCms');
    
    // Get all slots
    const allSlots = await PlantSlot.find({}).populate('plantId');
    console.log(`📅 Total slot documents: ${allSlots.length}`);
    
    if (allSlots.length > 0) {
      console.log('\n📋 Slot Details:');
      allSlots.forEach((slotDoc, index) => {
        console.log(`\n${index + 1}. Plant: ${slotDoc.plantId?.name || 'Unknown'} (ID: ${slotDoc.plantId})`);
        console.log(`   Year: ${slotDoc.year}`);
        console.log(`   Subtype Slots: ${slotDoc.subtypeSlots.length}`);
        
        slotDoc.subtypeSlots.forEach((subtypeSlot, subIndex) => {
          console.log(`     Subtype ${subIndex + 1}: ${subtypeSlot.subtypeName} (${subtypeSlot.slots.length} slots)`);
          
          // Show first few slots
          subtypeSlot.slots.slice(0, 3).forEach((slot, slotIndex) => {
            console.log(`       Slot ${slotIndex + 1}: ${slot.startDay} - ${slot.endDay} (${slot.totalPlants} plants)`);
          });
          
          if (subtypeSlot.slots.length > 3) {
            console.log(`       ... and ${subtypeSlot.slots.length - 3} more slots`);
          }
        });
      });
    } else {
      console.log('❌ No slots found in database');
    }
    
    // Check for specific plant and year
    const plantId = '68791b178721006afefe8043'; // Banana plant ID
    const year = 2025;
    
    console.log(`\n🔍 Checking for plant ${plantId} and year ${year}:`);
    const specificSlots = await PlantSlot.find({
      plantId: plantId,
      year: year
    });
    
    console.log(`Found ${specificSlots.length} slot documents for this plant and year`);
    
  } catch (error) {
    console.error('❌ Error checking slots:', error);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
  }
};

// Run the check
connectDB().then(() => {
  checkSlots().then(() => {
    console.log('🏁 Check completed');
    process.exit(0);
  });
}); 