#!/usr/bin/env node

/**
 * Quick Script: Reset All Dealer Passwords to 1234
 * 
 * This script directly updates all dealer passwords in the database
 * No API calls needed - direct database access
 */

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import User from './models/user.model.js';

// Load environment variables
dotenv.config();

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

// Default password for dealers
const DEFAULT_PASSWORD = '1234';

// Main function to reset dealer passwords
const resetDealerPasswords = async () => {
  try {
    console.log('\n🔐 Starting Dealer Password Reset...\n');
    console.log('═══════════════════════════════════════════════════════\n');

    // Hash the default password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, salt);
    console.log('🔒 Password hashed successfully\n');

    // Find all DEALER users (active only)
    const dealers = await User.find({
      $or: [
        { role: 'DEALER' },
        { jobTitle: 'DEALER' }
      ],
      isDisabled: { $ne: true }
    });

    if (dealers.length === 0) {
      console.log('⚠️  No active dealers found in the system\n');
      return;
    }

    console.log(`📊 Found ${dealers.length} active dealer(s)\n`);
    console.log('📋 Dealers to be updated:');
    console.log('───────────────────────────────────────────────────────\n');

    dealers.forEach((dealer, index) => {
      console.log(`${index + 1}. ${dealer.name}`);
      console.log(`   Phone: ${dealer.phoneNumber}`);
      console.log(`   Role: ${dealer.role || 'N/A'}`);
      console.log(`   Job Title: ${dealer.jobTitle || 'N/A'}`);
      console.log('');
    });

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('🔄 Updating passwords...\n');

    // Update all dealer passwords
    let successCount = 0;
    let errorCount = 0;

    for (const dealer of dealers) {
      try {
        await User.findByIdAndUpdate(
          dealer._id,
          {
            password: hashedPassword,
            isPasswordSet: false  // Force password change on next login
          }
        );

        console.log(`✅ Updated: ${dealer.name} (${dealer.phoneNumber})`);
        successCount++;
      } catch (error) {
        console.error(`❌ Failed to update ${dealer.name}:`, error.message);
        errorCount++;
      }
    }

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('📊 RESET SUMMARY');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log(`✅ Successfully updated: ${successCount} dealer(s)`);
    console.log(`❌ Failed to update: ${errorCount} dealer(s)`);
    console.log(`🔐 New password: ${DEFAULT_PASSWORD}`);
    console.log(`🔄 Force password change: YES`);
    console.log('\n✨ Dealers will be prompted to change their password on next login\n');

  } catch (error) {
    console.error('❌ Error resetting dealer passwords:', error);
    throw error;
  }
};

// Execute the script
const run = async () => {
  try {
    await connectDB();
    await resetDealerPasswords();
    console.log('✅ All done! Closing database connection...');
    await mongoose.connection.close();
    console.log('👋 Database connection closed. Goodbye!\n');
    process.exit(0);
  } catch (error) {
    console.error('❌ Fatal error:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
};

// Run the script
run();

