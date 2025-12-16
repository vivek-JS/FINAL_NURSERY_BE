import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import User from "./models/user.model.js";

// Load environment variables
dotenv.config();

// Use connection string exactly as check-database-connection.js does
// Try MONGO_URL first (as used in app.js), then MONGODB_URI, then default
const MONGODB_URI = process.env.MONGO_URL || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/nursery";

async function resetUserPassword() {
  try {
    console.log("===========================================");
    console.log("Reset Password for User: 2222255555");
    console.log("===========================================\n");

    // Connect to MongoDB
    console.log("Connecting to MongoDB...");
    console.log(`Connection string: ${MONGODB_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}\n`);
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB successfully");
    
    // Display which database we're connected to
    const dbName = mongoose.connection.db.databaseName;
    console.log(`Database: ${dbName}\n`);

    // Phone number to reset
    const PHONE_NUMBER = 2222255555;
    const NEW_PASSWORD = "12345";
    
    // Find the user
    console.log(`Finding user with phone number: ${PHONE_NUMBER}...`);
    let user = await User.findOne({ phoneNumber: PHONE_NUMBER });

    // Hash the new password
    console.log("Hashing new password...");
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(NEW_PASSWORD, salt);
    console.log("✓ Password hashed successfully\n");

    if (!user) {
      console.log(`⚠️  User with phone number ${PHONE_NUMBER} not found`);
      console.log("Creating new user...\n");
      
      // Create new user with default values
      user = new User({
        name: `User ${PHONE_NUMBER}`,
        phoneNumber: PHONE_NUMBER,
        password: hashedPassword,
        isPasswordSet: false,
        role: "FARMER",
        isDisabled: false,
        isOnboarded: false
      });
      
      await user.save();
      console.log("✓ New user created successfully\n");
    } else {
      console.log(`✓ User found:`);
      console.log(`   Name: ${user.name}`);
      console.log(`   Phone: ${user.phoneNumber}`);
      console.log(`   Role: ${user.role || 'N/A'}`);
      console.log(`   Job Title: ${user.jobTitle || 'N/A'}`);
      console.log(`   Disabled: ${user.isDisabled ? 'Yes' : 'No'}\n`);

      // Update the user's password
      console.log("Updating password...");
      await User.findByIdAndUpdate(
        user._id,
        {
          password: hashedPassword,
          isPasswordSet: false // Force password change on next login
        },
        { new: true }
      );
      console.log("✓ Password updated successfully\n");
    }

    console.log("===========================================");
    console.log("✓ SUCCESS!");
    console.log("===========================================");
    console.log(`Password for ${user.name} (${PHONE_NUMBER}) has been set to: ${NEW_PASSWORD}`);
    console.log("Note: User will be required to change password on next login");
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
resetUserPassword();

