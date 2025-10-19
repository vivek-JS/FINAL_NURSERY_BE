import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import User from "./models/user.model.js";

// Load environment variables
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/nursery";

async function createDispatchManager() {
  try {
    console.log("===========================================");
    console.log("Create Dispatch Manager: 7218186452");
    console.log("===========================================\n");

    // Connect to MongoDB
    console.log("Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB successfully\n");

    const PHONE_NUMBER = 7218186452;
    const PASSWORD = "1234";
    const NAME = "Dispatch Manager";
    
    // Check if user already exists
    console.log(`Checking if user ${PHONE_NUMBER} already exists...`);
    const existingUser = await User.findOne({ phoneNumber: PHONE_NUMBER });
    
    if (existingUser) {
      console.log(`⚠️  User already exists:`);
      console.log(`   Name: ${existingUser.name}`);
      console.log(`   Phone: ${existingUser.phoneNumber}`);
      console.log(`   Role: ${existingUser.role || 'N/A'}`);
      console.log(`   Job Title: ${existingUser.jobTitle || 'N/A'}\n`);
      
      // Update to dispatch manager role
      console.log("Updating user to Dispatch Manager role...");
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(PASSWORD, salt);
      
      await User.findByIdAndUpdate(
        existingUser._id,
        {
          role: 'DISPATCH_MANAGER',
          jobTitle: 'DISPATCH_MANAGER',
          password: hashedPassword,
          isPasswordSet: false
        },
        { new: true }
      );
      
      console.log("✓ User updated to Dispatch Manager with password: 1234\n");
    } else {
      // Create new user
      console.log("Creating new Dispatch Manager...");
      
      // Hash password
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(PASSWORD, salt);
      
      const newUser = new User({
        name: NAME,
        phoneNumber: PHONE_NUMBER,
        password: hashedPassword,
        role: 'DISPATCH_MANAGER',
        jobTitle: 'DISPATCH_MANAGER',
        isPasswordSet: false,
        isDisabled: false
      });
      
      await newUser.save();
      console.log("✓ Dispatch Manager created successfully\n");
    }

    console.log("===========================================");
    console.log("✓ SUCCESS!");
    console.log("===========================================");
    console.log(`User Details:`);
    console.log(`  Phone Number: ${PHONE_NUMBER}`);
    console.log(`  Password:     ${PASSWORD}`);
    console.log(`  Role:         DISPATCH_MANAGER`);
    console.log(`  Job Title:    DISPATCH_MANAGER`);
    console.log("\nYou can now login with these credentials.");
    console.log("User will be prompted to change password on first login.");
    console.log("");

    // Close connection
    await mongoose.connection.close();
    console.log("✓ MongoDB connection closed");
    
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
createDispatchManager();

