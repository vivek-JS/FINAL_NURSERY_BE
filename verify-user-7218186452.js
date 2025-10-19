import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import User from "./models/user.model.js";

// Load environment variables
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL || "mongodb://127.0.0.1:27017/nursery";

async function verifyUser() {
  try {
    console.log("===========================================");
    console.log("Verify User: 7218186452");
    console.log("===========================================\n");

    // Connect to MongoDB
    console.log("Connecting to MongoDB...");
    console.log("URI:", MONGODB_URI);
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB successfully\n");

    const PHONE_NUMBER = 7218186452;
    const TEST_PASSWORD = "1234";
    
    // Find the user
    console.log(`Finding user with phone number: ${PHONE_NUMBER}...`);
    const user = await User.findOne({ phoneNumber: PHONE_NUMBER });

    if (!user) {
      console.log(`❌ User with phone number ${PHONE_NUMBER} NOT FOUND`);
      await mongoose.connection.close();
      return;
    }

    console.log(`✓ User found in database:`);
    console.log(`   ID:           ${user._id}`);
    console.log(`   Name:         ${user.name}`);
    console.log(`   Phone:        ${user.phoneNumber}`);
    console.log(`   Role:         ${user.role || 'N/A'}`);
    console.log(`   Job Title:    ${user.jobTitle || 'N/A'}`);
    console.log(`   Disabled:     ${user.isDisabled ? 'Yes' : 'No'}`);
    console.log(`   Password Set: ${user.isPasswordSet ? 'Yes' : 'No'}`);
    console.log(`   Password Hash: ${user.password.substring(0, 30)}...`);
    console.log("");

    // Test password
    console.log(`Testing password: "${TEST_PASSWORD}"`);
    const isPasswordValid = await bcrypt.compare(TEST_PASSWORD, user.password);
    
    if (isPasswordValid) {
      console.log(`✓ Password is VALID ✓`);
    } else {
      console.log(`❌ Password is INVALID ❌`);
      console.log(`   The password "${TEST_PASSWORD}" does not match the stored hash`);
    }
    console.log("");

    // Try different phone number formats
    console.log("Testing different phone number formats:");
    const phoneVariants = [
      { format: "Number", value: 7218186452 },
      { format: "String", value: "7218186452" },
      { format: "Number (as string in query)", value: Number("7218186452") }
    ];
    
    for (const variant of phoneVariants) {
      const testUser = await User.findOne({ phoneNumber: variant.value });
      console.log(`  ${variant.format}: ${testUser ? '✓ FOUND' : '❌ NOT FOUND'}`);
    }

    console.log("\n===========================================");
    if (isPasswordValid && !user.isDisabled) {
      console.log("✓ User should be able to login successfully");
    } else {
      console.log("❌ There is an issue:");
      if (!isPasswordValid) console.log("  - Password does not match");
      if (user.isDisabled) console.log("  - User is disabled");
    }
    console.log("===========================================");

    // Close connection
    await mongoose.connection.close();
    console.log("\n✓ MongoDB connection closed");
    
  } catch (error) {
    console.error("\n❌ ERROR:", error.message);
    console.error(error);
    
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
    }
    
    process.exit(1);
  }
}

// Run the script
verifyUser();

