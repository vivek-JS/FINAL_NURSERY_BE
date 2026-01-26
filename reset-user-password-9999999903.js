import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import User from "./models/user.model.js";

// Load environment variables
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/nursery";

async function resetUserPassword() {
  try {
    console.log("===========================================");
    console.log("Reset Password for User: 9999999903");
    console.log("===========================================\n");

    // Connect to MongoDB
    console.log("Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB successfully\n");

    // Phone number to reset
    const PHONE_NUMBER = 9999999903;
    const NEW_PASSWORD = "12345";
    
    // Find the user
    console.log(`Finding user with phone number: ${PHONE_NUMBER}...`);
    let user = await User.findOne({ phoneNumber: PHONE_NUMBER });

    if (!user) {
      console.log(`⚠️  User with phone number ${PHONE_NUMBER} not found. Creating new user...`);
      // Hash the new password
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(NEW_PASSWORD, salt);
      
      // Create new user
      user = await User.create({
        name: `User ${PHONE_NUMBER}`,
        phoneNumber: PHONE_NUMBER,
        password: hashedPassword,
        isPasswordSet: true,
        role: "FARMER",
        isDisabled: false
      });
      console.log(`✓ New user created successfully\n`);
    } else {
      console.log(`✓ User found:`);
      console.log(`   Name: ${user.name}`);
      console.log(`   Phone: ${user.phoneNumber}`);
      console.log(`   Role: ${user.role || 'N/A'}`);
      console.log(`   Job Title: ${user.jobTitle || 'N/A'}`);
      console.log(`   Disabled: ${user.isDisabled ? 'Yes' : 'No'}\n`);

      // Hash the new password
      console.log("Hashing new password...");
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(NEW_PASSWORD, salt);
      console.log("✓ Password hashed successfully\n");

      // Update the user's password
      console.log("Updating password...");
      await User.findByIdAndUpdate(
        user._id,
        {
          password: hashedPassword,
          isPasswordSet: true // Set to true so user can login without forced password change
        },
        { new: true }
      );
      console.log("✓ Password updated successfully\n");
    }

    console.log("===========================================");
    console.log("✓ SUCCESS!");
    console.log("===========================================");
    console.log(`Password for ${user.name} (${PHONE_NUMBER}) has been reset.`);
    console.log(`New Password: ${NEW_PASSWORD}`);
    console.log("User can now login with this password.");
    console.log("===========================================\n");
  } catch (error) {
    console.error("❌ Error resetting password:", error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log("🔌 MongoDB connection closed");
  }
}

resetUserPassword();

