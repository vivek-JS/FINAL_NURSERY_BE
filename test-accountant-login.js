import mongoose from "mongoose";
import User from "./models/user.model.js";
import bcrypt from "bcryptjs";
import { generateTokenPair } from "./utility/jwtUtils.js";
import generateResponse from "./utility/responseFormat.js";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

async function testAccountantLogin() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URL);
    console.log("Connected to MongoDB successfully");

    // Test Accountant Login
    console.log("\n🧪 Testing Accountant Login...");
    const accountantPhone = 7588686451;
    const accountantPassword = "Nursery@2024";

    console.log(`Looking for accountant with phone number: ${accountantPhone}`);
    const accountant = await User.findOne({ phoneNumber: accountantPhone });

    if (!accountant) {
      console.log("❌ Accountant not found!");
      return;
    }

    console.log("✅ Accountant found:", {
      _id: accountant._id,
      name: accountant.name,
      phoneNumber: accountant.phoneNumber,
      role: accountant.role,
      jobTitle: accountant.jobTitle,
      isDisabled: accountant.isDisabled
    });

    // Check password
    const isAccountantPasswordValid = await bcrypt.compare(accountantPassword, accountant.password);
    console.log("Password valid:", isAccountantPasswordValid);

    if (!isAccountantPasswordValid) {
      console.log("❌ Accountant login should fail - wrong password");
    } else {
      console.log("✅ Accountant login should succeed!");
    }

    // Test Office Admin Login
    console.log("\n🧪 Testing Office Admin Login...");
    const officeAdminPhone = 7588686450;
    const officeAdminPassword = "Nursery@2024";

    console.log(`Looking for office admin with phone number: ${officeAdminPhone}`);
    const officeAdmin = await User.findOne({ phoneNumber: officeAdminPhone });

    if (!officeAdmin) {
      console.log("❌ Office Admin not found!");
      return;
    }

    console.log("✅ Office Admin found:", {
      _id: officeAdmin._id,
      name: officeAdmin.name,
      phoneNumber: officeAdmin.phoneNumber,
      role: officeAdmin.role,
      jobTitle: officeAdmin.jobTitle,
      isDisabled: officeAdmin.isDisabled
    });

    // Check password
    const isOfficeAdminPasswordValid = await bcrypt.compare(officeAdminPassword, officeAdmin.password);
    console.log("Password valid:", isOfficeAdminPasswordValid);

    if (!isOfficeAdminPasswordValid) {
      console.log("❌ Office Admin login should fail - wrong password");
    } else {
      console.log("✅ Office Admin login should succeed!");
    }

    console.log("\n📋 Login Test Summary:");
    console.log("Accountant (Vivek):", isAccountantPasswordValid ? "✅ Can login" : "❌ Cannot login");
    console.log("Office Admin (Sunil):", isOfficeAdminPasswordValid ? "✅ Can login" : "❌ Cannot login");
    console.log("Default password for both: Nursery@2024");

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await mongoose.disconnect();
    console.log("\nDisconnected from MongoDB");
  }
}

// Run the test
testAccountantLogin(); 