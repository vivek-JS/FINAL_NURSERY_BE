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

// Test function to check plants
const testPlants = async () => {
  try {
    console.log('🔍 Checking plants in database...');
    
    // Get PlantCms model
    const PlantCms = mongoose.model('PlantCms');
    
    // Count plants
    const plantCount = await PlantCms.countDocuments();
    console.log(`📊 Total plants in database: ${plantCount}`);
    
    if (plantCount > 0) {
      // Get first few plants
      const plants = await PlantCms.find({}).select('name subtypes').limit(5);
      console.log('🌱 Sample plants:');
      plants.forEach((plant, index) => {
        console.log(`  ${index + 1}. ${plant.name} (${plant.subtypes.length} subtypes)`);
      });
    } else {
      console.log('❌ No plants found in database');
    }
    
    // Check PlantSlot collection
    const PlantSlot = mongoose.model('PlantSlot');
    const slotCount = await PlantSlot.countDocuments();
    console.log(`📅 Total slots in database: ${slotCount}`);
    
  } catch (error) {
    console.error('❌ Error checking plants:', error);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
  }
};

// Run the test
connectDB().then(() => {
  testPlants().then(() => {
    console.log('🏁 Test completed');
    process.exit(0);
  });
}); 