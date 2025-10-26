import mongoose from 'mongoose';
import User from './models/user.model.js';

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/nursery-management');
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Fix user role for 1111155555
const fixUserRole = async () => {
  try {
    await connectDB();
    
    const phoneNumber = 1111155555;
    console.log(`🔍 Finding user with phone number: ${phoneNumber}`);
    
    const user = await User.findOne({ phoneNumber: phoneNumber });
    
    if (!user) {
      console.log(`❌ User with phone number ${phoneNumber} not found`);
      return;
    }
    
    console.log(`\n📋 Current User Details:`);
    console.log(`   Name: ${user.name}`);
    console.log(`   Phone: ${user.phoneNumber}`);
    console.log(`   Current Role: ${user.role}`);
    console.log(`   Current Job Title: ${user.jobTitle}`);
    console.log(`   Is Onboarded: ${user.isOnboarded}`);
    console.log(`   Is Password Set: ${user.isPasswordSet}`);
    console.log(`   Is Disabled: ${user.isDisabled}`);
    
    // Fix the role mismatch
    if (user.jobTitle === "ACCOUNTANT" && user.role !== "ACCOUNTANT") {
      console.log(`\n🔧 Fixing role mismatch...`);
      console.log(`   Role: ${user.role} → ACCOUNTANT`);
      
      user.role = "ACCOUNTANT";
      user.isOnboarded = true; // Set as onboarded since they can login
      
      await user.save();
      
      console.log(`\n✅ User role fixed successfully!`);
      console.log(`📋 Updated User Details:`);
      console.log(`   Name: ${user.name}`);
      console.log(`   Phone: ${user.phoneNumber}`);
      console.log(`   Role: ${user.role}`);
      console.log(`   Job Title: ${user.jobTitle}`);
      console.log(`   Is Onboarded: ${user.isOnboarded}`);
      console.log(`   Is Password Set: ${user.isPasswordSet}`);
      console.log(`   Is Disabled: ${user.isDisabled}`);
      
      console.log(`\n🎉 User ${phoneNumber} now has correct ACCOUNTANT role!`);
      console.log(`📱 They should now see only ACCOUNTANT-appropriate features`);
      console.log(`🔑 WhatsApp Management should no longer be visible`);
      
    } else {
      console.log(`\n✅ User role is already correct`);
    }
    
  } catch (error) {
    console.error('❌ Error fixing user role:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
  }
};

// Run the fix
fixUserRole();
