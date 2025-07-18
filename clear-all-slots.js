import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/nursery');
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Import the Slot model
const Slot = mongoose.model('Slot', new mongoose.Schema({}));

const clearAllSlots = async () => {
  try {
    console.log('🗑️  Starting to clear all slots...');
    
    // Count slots before deletion
    const countBefore = await Slot.countDocuments();
    console.log(`📊 Found ${countBefore} slots to delete`);
    
    if (countBefore === 0) {
      console.log('✅ No slots found to delete');
      return;
    }
    
    // Delete all slots
    const result = await Slot.deleteMany({});
    
    console.log(`✅ Successfully deleted ${result.deletedCount} slots`);
    
    // Verify deletion
    const countAfter = await Slot.countDocuments();
    console.log(`📊 Remaining slots: ${countAfter}`);
    
    if (countAfter === 0) {
      console.log('🎉 All slots have been cleared successfully!');
    } else {
      console.log('⚠️  Some slots may still exist');
    }
    
  } catch (error) {
    console.error('❌ Error clearing slots:', error);
  } finally {
    // Close database connection
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
  }
};

// Run the script
connectDB().then(() => {
  clearAllSlots().then(() => {
    console.log('🏁 Script completed');
    process.exit(0);
  });
}); 