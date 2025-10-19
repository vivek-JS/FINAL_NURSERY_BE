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

// Update specific user to PIN 1234
const updateUserPin = async () => {
  try {
    const phoneNumber = 9309109344;
    const newPin = '1234';
    
    console.log('🔐 Updating user to 4-digit PIN system');
    console.log('═══════════════════════════════════════════════════════\n');
    
    // Find user
    const user = await User.findOne({ phoneNumber: phoneNumber });
    
    if (!user) {
      console.log('❌ User not found');
      return;
    }
    
    console.log(`📱 Found user: ${user.name} (${phoneNumber})`);
    console.log(`Current status: isPasswordSet = ${user.isPasswordSet}\n`);
    
    // Hash the new PIN
    const hashedPin = await bcrypt.hash(newPin, 10);
    console.log('🔒 New PIN hashed successfully\n');
    
    // Update user
    await User.findByIdAndUpdate(
      user._id,
      {
        password: hashedPin,
        isPasswordSet: false // Force PIN change on next login
      }
    );
    
    console.log('✅ User updated successfully!\n');
    console.log('═══════════════════════════════════════════════════════');
    console.log('📋 UPDATED USER INFO:');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`Name:           ${user.name}`);
    console.log(`Phone:          ${phoneNumber}`);
    console.log(`New PIN:        ${newPin}`);
    console.log(`isPasswordSet:  false (will force PIN change)`);
    console.log('═══════════════════════════════════════════════════════\n');
    
    console.log('📱 LOGIN INSTRUCTIONS:');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`1. Open Android app`);
    console.log(`2. Phone: ${phoneNumber}`);
    console.log(`3. PIN: ${newPin}`);
    console.log(`4. PIN change modal will appear`);
    console.log(`5. Set your new 4-digit PIN`);
    console.log(`6. Access granted!`);
    console.log('═══════════════════════════════════════════════════════\n');
    
  } catch (error) {
    console.error('❌ Error updating user:', error);
    throw error;
  }
};

// Execute
const run = async () => {
  try {
    await connectDB();
    await updateUserPin();
    console.log('✨ Done!');
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

