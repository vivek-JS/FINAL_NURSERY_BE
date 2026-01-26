import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import User from "./models/user.model.js";

// Production-ready MongoDB connection options
const mongoOptions = {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 10000,
  maxPoolSize: 10,
  minPoolSize: 1,
  retryWrites: true,
  w: 'majority',
  retryReads: true,
};

const updateSuperAdminJobTitle = async () => {
  try {
    console.log('🔌 Connecting to database...');
    
    await mongoose.connect(process.env.MONGO_URL, mongoOptions);
    
    console.log(`✅ Connected to database: ${mongoose.connection.db.databaseName}\n`);
    
    // Find super admin user
    const phoneNumber = 7588686452;
    const superAdmin = await User.findOne({ phoneNumber });
    
    if (!superAdmin) {
      console.log(`❌ User with phone number ${phoneNumber} not found!`);
      return;
    }
    
    console.log('📋 Current Details:');
    console.log(`   Name: ${superAdmin.name}`);
    console.log(`   Phone: ${superAdmin.phoneNumber}`);
    console.log(`   Role: ${superAdmin.role}`);
    console.log(`   Job Title: ${superAdmin.jobTitle || 'Not set'}\n`);
    
    // Update job title to SUPER_ADMIN
    const oldJobTitle = superAdmin.jobTitle;
    superAdmin.jobTitle = "SUPER_ADMIN";
    await superAdmin.save();
    
    console.log('✅ Updated Super Admin Job Title:');
    console.log(`   Role: ${superAdmin.role}`);
    console.log(`   Job Title: ${oldJobTitle || 'Not set'} → ${superAdmin.jobTitle}`);
    
    // Verify the update
    const updatedUser = await User.findOne({ phoneNumber });
    console.log('\n🔍 Verification:');
    console.log(`   Name: ${updatedUser.name}`);
    console.log(`   Phone: ${updatedUser.phoneNumber}`);
    console.log(`   Role: ${updatedUser.role}`);
    console.log(`   Job Title: ${updatedUser.jobTitle}`);
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from database');
  }
};

updateSuperAdminJobTitle();
