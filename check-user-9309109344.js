import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Import the User model
import User from './models/user.model.js';

// Database connection
const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGO_URL || process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/nursery-management';
    await mongoose.connect(mongoUri);
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Check user details
const checkUser = async () => {
  try {
    const phoneNumber = 9309109344;
    
    console.log('🔍 Searching for user with phone:', phoneNumber);
    console.log('═══════════════════════════════════════════════════════\n');
    
    const user = await User.findOne({ phoneNumber: phoneNumber });
    
    if (!user) {
      console.log('❌ User NOT FOUND');
      console.log('\nPossible reasons:');
      console.log('  1. User does not exist in database');
      console.log('  2. Phone number is incorrect');
      console.log('  3. Phone number format is different');
      console.log('\nSearching for similar phone numbers...');
      
      // Search for similar phone numbers
      const similarUsers = await User.find({
        phoneNumber: { $gte: 9309109340, $lte: 9309109349 }
      });
      
      if (similarUsers.length > 0) {
        console.log('\n📱 Found similar phone numbers:');
        similarUsers.forEach(u => {
          console.log(`  - ${u.phoneNumber}: ${u.name} (${u.role || u.jobTitle})`);
        });
      } else {
        console.log('\n❌ No similar phone numbers found');
      }
      
      return;
    }
    
    console.log('✅ USER FOUND!\n');
    console.log('📋 User Details:');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`Name:           ${user.name}`);
    console.log(`Phone Number:   ${user.phoneNumber}`);
    console.log(`Role:           ${user.role || 'N/A'}`);
    console.log(`Job Title:      ${user.jobTitle || 'N/A'}`);
    console.log(`Is Disabled:    ${user.isDisabled}`);
    console.log(`Is Password Set: ${user.isPasswordSet}`);
    console.log(`Is Onboarded:   ${user.isOnboarded}`);
    console.log(`User ID:        ${user._id}`);
    console.log('═══════════════════════════════════════════════════════\n');
    
    // Test password validation
    console.log('🔐 Password Testing:');
    console.log('═══════════════════════════════════════════════════════');
    
    const testPins = ['1234', '12345678', 'password123'];
    
    for (const testPin of testPins) {
      try {
        const isMatch = await bcrypt.compare(testPin, user.password);
        if (isMatch) {
          console.log(`✅ Password MATCH with: "${testPin}"`);
        } else {
          console.log(`❌ Password does NOT match: "${testPin}"`);
        }
      } catch (error) {
        console.log(`⚠️  Error testing password "${testPin}":`, error.message);
      }
    }
    
    console.log('═══════════════════════════════════════════════════════\n');
    
    // Login diagnostics
    console.log('🩺 Login Diagnostics:');
    console.log('═══════════════════════════════════════════════════════');
    
    const issues = [];
    const suggestions = [];
    
    if (user.isDisabled) {
      issues.push('❌ User account is DISABLED');
      suggestions.push('Enable the account using admin panel or database');
    } else {
      console.log('✅ Account is NOT disabled');
    }
    
    if (!user.isPasswordSet) {
      console.log('⚠️  isPasswordSet is FALSE - Will show PIN change modal');
      suggestions.push('User should login with default PIN (1234) and set new PIN');
    } else {
      console.log('✅ isPasswordSet is TRUE - Normal login');
    }
    
    if (!user.role && !user.jobTitle) {
      issues.push('⚠️  No role or job title assigned');
      suggestions.push('Assign appropriate role to user');
    }
    
    console.log('═══════════════════════════════════════════════════════\n');
    
    if (issues.length > 0) {
      console.log('🚨 ISSUES FOUND:');
      issues.forEach(issue => console.log(`  ${issue}`));
      console.log('');
    }
    
    if (suggestions.length > 0) {
      console.log('💡 SUGGESTIONS:');
      suggestions.forEach(suggestion => console.log(`  • ${suggestion}`));
      console.log('');
    }
    
    // Login instructions
    console.log('📱 LOGIN INSTRUCTIONS:');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`Phone Number: ${phoneNumber}`);
    
    if (!user.isPasswordSet) {
      console.log('PIN: 1234 (default - must be changed on first login)');
    } else {
      console.log('PIN: [User\'s custom PIN - set by user]');
    }
    
    console.log('\nExpected behavior:');
    if (user.isDisabled) {
      console.log('  ❌ Login will FAIL - Account disabled');
    } else if (!user.isPasswordSet) {
      console.log('  ✅ Login with PIN 1234 will succeed');
      console.log('  📱 PIN change modal will appear');
      console.log('  🔒 User must set new 4-digit PIN');
    } else {
      console.log('  ✅ Login with user\'s custom PIN will succeed');
      console.log('  📊 Direct access to dashboard');
    }
    
    console.log('═══════════════════════════════════════════════════════\n');
    
  } catch (error) {
    console.error('❌ Error checking user:', error);
    throw error;
  }
};

// Execute
const run = async () => {
  try {
    await connectDB();
    await checkUser();
    console.log('✅ Check completed!');
    await mongoose.connection.close();
    console.log('👋 Database connection closed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Fatal error:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
};

run();

