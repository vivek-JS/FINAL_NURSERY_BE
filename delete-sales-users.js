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

// Import the User model
import User from './models/user.model.js';

// Function to delete all sales users
const deleteSalesUsers = async () => {
  try {
    await connectDB();

    console.log('🔍 Finding all users with role "SALES"...');

    // Find all sales users first to show what will be deleted
    const salesUsers = await User.find({ role: 'SALES' });
    
    console.log(`📊 Found ${salesUsers.length} sales users:`);
    
    if (salesUsers.length > 0) {
      salesUsers.forEach((user, index) => {
        console.log(`${index + 1}. ${user.name} (${user.phoneNumber}) - ${user.role}`);
      });
    } else {
      console.log('❌ No sales users found in the database');
      return;
    }

    console.log('\n⚠️  WARNING: This will permanently delete all sales users!');
    console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...');
    
    // Wait 5 seconds to give user time to cancel
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('\n🗑️  Deleting all sales users...');

    // Delete all users with role SALES
    const deleteResult = await User.deleteMany({ role: 'SALES' });

    console.log(`✅ Successfully deleted ${deleteResult.deletedCount} sales users`);
    console.log('🎉 All sales users have been removed from the database');

  } catch (error) {
    console.error('❌ Error deleting sales users:', error);
  } finally {
    mongoose.connection.close();
    console.log('Database connection closed');
  }
};

// Run the script
deleteSalesUsers(); 