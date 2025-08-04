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

// Import User model
import User from './models/user.model.js';

// Function to delete all farmers
const deleteAllFarmers = async () => {
  try {
    await connectDB();

    console.log('👥 Starting farmer deletion...');
    console.log('🗑️ Deleting: All users with FARMER role');
    console.log('✅ Preserving: SUPER_ADMIN, SALES, DEALER, and other roles');

    // Get all farmers before deletion
    const farmers = await User.find({ role: 'FARMER' }, 'name phoneNumber role jobTitle');
    console.log(`\n👨‍🌾 Found ${farmers.length} farmers to delete:`);
    
    farmers.forEach(farmer => {
      console.log(`   - ${farmer.name} (${farmer.phoneNumber}) - ${farmer.role}${farmer.jobTitle ? ` - ${farmer.jobTitle}` : ''}`);
    });

    // Get count of other users to preserve
    const otherUsers = await User.countDocuments({ role: { $ne: 'FARMER' } });
    console.log(`\n✅ ${otherUsers} non-farmer users will be preserved`);

    // Confirm deletion
    console.log('\n⚠️  WARNING: This will permanently delete all farmers!');
    console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...');
    
    // Wait 5 seconds for user to cancel
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Delete all farmers
    console.log('\n🗑️ Deleting all farmers...');
    const deleteResult = await User.deleteMany({ role: 'FARMER' });
    console.log(`✅ Deleted ${deleteResult.deletedCount} farmers`);

    // Verify remaining users
    const remainingUsers = await User.countDocuments();
    const remainingFarmers = await User.countDocuments({ role: 'FARMER' });
    
    console.log(`\n✅ Verification:`);
    console.log(`   - Total users remaining: ${remainingUsers}`);
    console.log(`   - Farmers remaining: ${remainingFarmers}`);

    // Show remaining users
    const remainingUserList = await User.find({}, 'name phoneNumber role jobTitle');
    console.log('\n👥 Remaining Users:');
    remainingUserList.forEach(user => {
      console.log(`   - ${user.name} (${user.phoneNumber}) - ${user.role}${user.jobTitle ? ` - ${user.jobTitle}` : ''}`);
    });

    console.log('\n🎉 Farmer deletion completed successfully!');
    console.log('📊 Summary:');
    console.log(`   - Farmers deleted: ${deleteResult.deletedCount}`);
    console.log(`   - Users remaining: ${remainingUsers}`);

  } catch (error) {
    console.error('❌ Error during farmer deletion:', error);
  } finally {
    mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
};

// Run the script
deleteAllFarmers(); 