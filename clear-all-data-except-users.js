import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Connect to MongoDB
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URL || 'mongodb://localhost:27017/nursery-management');
    console.log('MongoDB Connected:', conn.connection.host);
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
    process.exit(1);
  }
};

// Import models
import Order from './models/order.model.js';
import PlantSlot from './models/slots.model.js';
import PlantCms from './models/plantCms.model.js';
import User from './models/user.model.js';

// Function to clear all data except users
const clearAllDataExceptUsers = async () => {
  try {
    await connectDB();

    console.log('🗑️ Starting data cleanup...');
    console.log('📊 Preserving: Users (Farmers & Employees)');
    console.log('🗑️ Clearing: Orders, Slots, Plant CMS (includes subtypes)');

    // Get user count before clearing
    const userCount = await User.countDocuments();
    console.log(`👥 Found ${userCount} users (will be preserved)`);

    // Clear Orders
    console.log('\n📦 Clearing Orders...');
    const orderResult = await Order.deleteMany({});
    console.log(`✅ Deleted ${orderResult.deletedCount} orders`);

    // Clear Plant Slots
    console.log('\n🌱 Clearing Plant Slots...');
    const slotResult = await PlantSlot.deleteMany({});
    console.log(`✅ Deleted ${slotResult.deletedCount} plant slots`);

    // Clear Plant CMS (includes subtypes)
    console.log('\n🌿 Clearing Plant CMS (includes subtypes)...');
    const plantResult = await PlantCms.deleteMany({});
    console.log(`✅ Deleted ${plantResult.deletedCount} plant CMS entries`);

    // Verify users are still there
    const remainingUsers = await User.countDocuments();
    console.log(`\n✅ Verification: ${remainingUsers} users still preserved`);

    // Show user summary
    const users = await User.find({}, 'name phoneNumber role jobTitle');
    console.log('\n👥 Preserved Users:');
    users.forEach(user => {
      console.log(`   - ${user.name} (${user.phoneNumber}) - ${user.role}${user.jobTitle ? ` - ${user.jobTitle}` : ''}`);
    });

    console.log('\n🎉 Data cleanup completed successfully!');
    console.log('📊 Summary:');
    console.log(`   - Orders deleted: ${orderResult.deletedCount}`);
    console.log(`   - Slots deleted: ${slotResult.deletedCount}`);
    console.log(`   - Plant CMS deleted: ${plantResult.deletedCount}`);
    console.log(`   - Users preserved: ${remainingUsers}`);

  } catch (error) {
    console.error('❌ Error during data cleanup:', error);
  } finally {
    mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
};

// Run the script
clearAllDataExceptUsers(); 