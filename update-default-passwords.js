import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
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

// New default password
const NEW_DEFAULT_PASSWORD = '12345678';

// Function to hash password
const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

// Function to update all user passwords
const updateAllPasswords = async () => {
  try {
    await connectDB();

    console.log('🔐 Updating all user passwords to new default: 12345678');
    
    // Get all users
    const users = await User.find({});
    console.log(`📊 Found ${users.length} users in the database`);

    const hashedPassword = await hashPassword(NEW_DEFAULT_PASSWORD);
    let updatedCount = 0;

    for (const user of users) {
      // Update password
      user.password = hashedPassword;
      user.isPasswordSet = false; // Reset password set flag so they can set new password
      await user.save();
      
      console.log(`✅ Updated password for: ${user.name} (${user.phoneNumber})`);
      updatedCount++;
    }

    console.log(`\n🎉 Successfully updated ${updatedCount} users`);
    console.log('🔑 New default password for all users: 12345678');
    console.log('📱 Users will see password set popup on first login');

  } catch (error) {
    console.error('Error updating passwords:', error);
  } finally {
    mongoose.connection.close();
    console.log('Database connection closed');
  }
};

// Run the script
updateAllPasswords(); 