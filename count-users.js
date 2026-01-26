import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import User from "./models/user.model.js";

// Production-ready MongoDB connection options
const mongoOptions = {
  serverSelectionTimeoutMS: 10000, // 10 seconds timeout
  socketTimeoutMS: 45000, // 45 seconds socket timeout
  connectTimeoutMS: 10000, // 10 seconds connection timeout
  maxPoolSize: 10, // Maintain up to 10 socket connections
  minPoolSize: 1,
  retryWrites: true,
  w: 'majority',
  retryReads: true,
};

const countUsers = async () => {
  try {
    console.log('🔌 Connecting to database...');
    console.log(`Connection string: ${process.env.MONGO_URL ? 'MONGO_URL is set' : 'MONGO_URL not found in .env'}`);
    
    await mongoose.connect(process.env.MONGO_URL, mongoOptions);
    
    console.log(`✅ Connected to database: ${mongoose.connection.name}@${mongoose.connection.host}:${mongoose.connection.port}`);
    console.log(`Database: ${mongoose.connection.db.databaseName}`);
    
    // Count total users
    const totalUsers = await User.countDocuments({});
    console.log(`\n📊 Total Users in Database: ${totalUsers}`);
    
    // Count users by role
    const usersByRole = await User.aggregate([
      {
        $group: {
          _id: "$role",
          count: { $sum: 1 }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);
    
    if (usersByRole.length > 0) {
      console.log('\n📋 Users by Role:');
      usersByRole.forEach(({ _id, count }) => {
        console.log(`   ${_id || 'No role'}: ${count}`);
      });
    }
    
    // Count enabled vs disabled users
    const enabledUsers = await User.countDocuments({ isDisabled: false });
    const disabledUsers = await User.countDocuments({ isDisabled: true });
    console.log(`\n✅ Enabled Users: ${enabledUsers}`);
    console.log(`❌ Disabled Users: ${disabledUsers}`);
    
    // Count onboarded users
    const onboardedUsers = await User.countDocuments({ isOnboarded: true });
    const notOnboardedUsers = await User.countDocuments({ isOnboarded: false });
    console.log(`\n📱 Onboarded Users: ${onboardedUsers}`);
    console.log(`📱 Not Onboarded Users: ${notOnboardedUsers}`);
    
  } catch (error) {
    console.error('❌ Error connecting to database or counting users:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from database');
  }
};

// Run the count
countUsers();
