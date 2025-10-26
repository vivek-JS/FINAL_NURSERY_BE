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

// List all users to find the correct phone number
const listAllUsers = async () => {
  try {
    await connectDB();
    
    console.log('📋 All Users in Database:');
    console.log('=' .repeat(80));
    
    const users = await User.find({}).select('name phoneNumber role jobTitle isOnboarded isPasswordSet isDisabled createdAt');
    
    if (users.length === 0) {
      console.log('❌ No users found in database');
      return;
    }
    
    users.forEach((user, index) => {
      console.log(`${index + 1}. Name: ${user.name}`);
      console.log(`   Phone: ${user.phoneNumber}`);
      console.log(`   Role: ${user.role}`);
      console.log(`   Job Title: ${user.jobTitle}`);
      console.log(`   Onboarded: ${user.isOnboarded ? '✅' : '❌'}`);
      console.log(`   Password Set: ${user.isPasswordSet ? '✅' : '❌'}`);
      console.log(`   Disabled: ${user.isDisabled ? '❌' : '✅'}`);
      console.log(`   Created: ${user.createdAt}`);
      console.log('   ' + '-'.repeat(60));
    });
    
    console.log(`\n📊 Total Users: ${users.length}`);
    
    // Check for users with similar phone numbers
    const similarUsers = users.filter(user => 
      user.phoneNumber.toString().includes('1111') || 
      user.phoneNumber.toString().includes('5555')
    );
    
    if (similarUsers.length > 0) {
      console.log('\n🔍 Users with similar phone numbers (containing 1111 or 5555):');
      similarUsers.forEach(user => {
        console.log(`   ${user.name} - ${user.phoneNumber}`);
      });
    }
    
  } catch (error) {
    console.error('❌ Error listing users:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
  }
};

// Run the list
listAllUsers();