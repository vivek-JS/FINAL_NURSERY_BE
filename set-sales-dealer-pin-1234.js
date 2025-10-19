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

// Default PIN for sales and dealers
const DEFAULT_PIN = '1234';

// Function to hash password/PIN
const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

// Main migration function
const setSalesDealerPinTo1234 = async () => {
  try {
    console.log('🔐 Starting PIN migration for Sales and Dealer users...\n');

    // Hash the default PIN
    const hashedPin = await hashPassword(DEFAULT_PIN);
    console.log('🔒 Default PIN hashed successfully\n');

    // Find all SALES users (by role or jobTitle)
    const salesUsers = await User.find({
      $or: [
        { role: 'SALES' },
        { jobTitle: 'SALES' }
      ],
      isDisabled: { $ne: true } // Exclude disabled users
    });

    console.log(`📊 Found ${salesUsers.length} SALES users\n`);

    // Find all DEALER users (by role or jobTitle)
    const dealerUsers = await User.find({
      $or: [
        { role: 'DEALER' },
        { jobTitle: 'DEALER' }
      ],
      isDisabled: { $ne: true } // Exclude disabled users
    });

    console.log(`📊 Found ${dealerUsers.length} DEALER users\n`);

    // Combine all users
    const allUsers = [...salesUsers, ...dealerUsers];

    if (allUsers.length === 0) {
      console.log('⚠️  No SALES or DEALER users found. Exiting...\n');
      return;
    }

    console.log(`🎯 Total users to update: ${allUsers.length}\n`);
    console.log('📋 Users to be updated:');
    console.log('═══════════════════════════════════════════════════════\n');

    allUsers.forEach((user, index) => {
      console.log(`${index + 1}. Name: ${user.name}`);
      console.log(`   Phone: ${user.phoneNumber}`);
      console.log(`   Role: ${user.role || 'N/A'}`);
      console.log(`   Job Title: ${user.jobTitle || 'N/A'}`);
      console.log(`   Current isPasswordSet: ${user.isPasswordSet}`);
      console.log('');
    });

    console.log('═══════════════════════════════════════════════════════\n');

    // Ask for confirmation (in production, you might want to skip this)
    console.log('⚠️  This will:');
    console.log('   1. Set password to "1234" (hashed)');
    console.log('   2. Set isPasswordSet to false');
    console.log('   3. Force users to change PIN on next login\n');

    // Update all users
    let successCount = 0;
    let errorCount = 0;

    for (const user of allUsers) {
      try {
        await User.findByIdAndUpdate(
          user._id,
          {
            password: hashedPin,
            isPasswordSet: false
          }
        );

        console.log(`✅ Updated: ${user.name} (${user.phoneNumber})`);
        successCount++;
      } catch (error) {
        console.error(`❌ Failed to update ${user.name}:`, error.message);
        errorCount++;
      }
    }

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('📊 MIGRATION SUMMARY');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log(`✅ Successfully updated: ${successCount} users`);
    console.log(`❌ Failed to update: ${errorCount} users`);
    console.log(`📱 Default PIN set to: ${DEFAULT_PIN}`);
    console.log(`🔐 isPasswordSet: false (will force PIN change on login)`);
    console.log('\n✨ Migration completed successfully!\n');

  } catch (error) {
    console.error('❌ Migration error:', error);
    throw error;
  }
};

// Execute the migration
const runMigration = async () => {
  try {
    await connectDB();
    await setSalesDealerPinTo1234();
    console.log('✅ All done! Closing database connection...');
    await mongoose.connection.close();
    console.log('👋 Database connection closed. Goodbye!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Fatal error:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
};

// Run the migration
runMigration();

