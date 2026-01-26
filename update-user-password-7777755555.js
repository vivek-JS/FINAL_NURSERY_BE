import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "./models/user.model.js";
import dotenv from "dotenv";

dotenv.config();

const DEFAULT_DB_URI = "mongodb://localhost:27017/nursery";
const MONGODB_URI = process.env.MONGO_URL || process.env.MONGODB_URI || DEFAULT_DB_URI;

const phoneNumber = 7777755555;
const newPassword = "12345";

const resetPassword = async () => {
  console.log("===========================================");
  console.log(`Reset Password for User: ${phoneNumber}`);
  console.log("===========================================\n");

  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB successfully\n");

    console.log(`Finding user with phone number: ${phoneNumber}...`);
    const user = await User.findOne({ phoneNumber });

    if (!user) {
      console.log(`❌ User with phone number ${phoneNumber} not found`);
      return;
    }

    console.log("✓ User found:");
    console.log(`   Name: ${user.name}`);
    console.log(`   Phone: ${user.phoneNumber}`);
    console.log(`   Role: ${user.role || "N/A"}`);
    console.log(`   Job Title: ${user.jobTitle || "N/A"}`);
    console.log(`   Disabled: ${user.isDisabled ? "Yes" : "No"}\n`);

    console.log("Hashing new password...");
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    console.log("✓ Password hashed successfully\n");

    console.log("Updating password...");
    await User.findByIdAndUpdate(
      user._id,
      {
        password: hashedPassword,
        isPasswordSet: false
      },
      { new: true }
    );
    console.log("✓ Password updated successfully\n");

    console.log("===========================================");
    console.log("✓ SUCCESS!");
    console.log("===========================================");
    console.log(`Password for ${user.name} (${phoneNumber}) has been reset.`);
    console.log(`New Password: ${newPassword}`);
    console.log("User will be asked to set a new password on next login.");
    console.log("===========================================\n");
  } catch (error) {
    console.error("❌ Error resetting password:", error.message);
    console.error(error);
  } finally {
    await mongoose.connection.close();
    console.log("🔌 MongoDB connection closed");
  }
};

resetPassword();

