import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
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

// Check user details and password status
const checkUser = async () => {
  try {
    await connectDB();
    
    const phoneNumber = 1111155555;
    console.log(`🔍 Checking user with phone number: ${phoneNumber}`);
    
    // Find the user
    const user = await User.findOne({ phoneNumber: phoneNumber });
    
    if (!user) {
      console.log(`❌ User with phone number ${phoneNumber} not found`);
      return;
    }
    
    console.log(`\n📋 User Details:`);
    console.log(`   Name: ${user.name}`);
    console.log(`   Phone Number: ${user.phoneNumber}`);
    console.log(`   Role: ${user.role}`);
    console.log(`   Job Title: ${user.jobTitle}`);
    console.log(`   Is Onboarded: ${user.isOnboarded}`);
    console.log(`   Is Password Set: ${user.isPasswordSet}`);
    console.log(`   Is Disabled: ${user.isDisabled}`);
    console.log(`   Created At: ${user.createdAt}`);
    console.log(`   Updated At: ${user.updatedAt}`);
    
    // Test password verification
    console.log(`\n🔑 Password Testing:`);
    const defaultPassword = "12345678";
    const isPasswordCorrect = await bcrypt.compare(defaultPassword, user.password);
    console.log(`   Default password "12345678" matches: ${isPasswordCorrect ? '✅ YES' : '❌ NO'}`);
    
    // Check if password is hashed
    const isHashed = user.password.startsWith('$2');
    console.log(`   Password is hashed: ${isHashed ? '✅ YES' : '❌ NO'}`);
    
    if (!isPasswordCorrect) {
      console.log(`\n⚠️  Password Issue Detected:`);
      console.log(`   The user cannot login with the default password "12345678"`);
      console.log(`   This could be because:`);
      console.log(`   1. Password was changed manually`);
      console.log(`   2. Password was reset`);
      console.log(`   3. User was created with a different password`);
      
      console.log(`\n🔧 Suggested Solutions:`);
      console.log(`   1. Reset password to default: "12345678"`);
      console.log(`   2. Set isPasswordSet to false to force password reset`);
      console.log(`   3. Check if user needs to be re-onboarded`);
    } else {
      console.log(`\n✅ User can login with default password "12345678"`);
    }
    
  } catch (error) {
    console.error('❌ Error checking user:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
  }
};

// Run the check
checkUser();
