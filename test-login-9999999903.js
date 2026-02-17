import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import User from "./models/user.model.js";

dotenv.config();
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/nursery";

async function testLogin() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB\n");

    // Simulate exact login logic from controller
    const reqBody = {
      phoneNumber: "9999999903",
      password: "12345"
    };

    console.log("Request body:", reqBody);
    const { password } = reqBody;
    let phoneNumber = Number(reqBody?.phoneNumber);

    console.log("Converted phoneNumber:", phoneNumber);
    console.log("Is NaN:", isNaN(phoneNumber));

    // Validate phoneNumber
    if (!reqBody?.phoneNumber || isNaN(phoneNumber)) {
      console.log("❌ Invalid phone number");
      return;
    }

    console.log("Looking for user with phone number:", phoneNumber);
    const user = await User.findOne({ phoneNumber: phoneNumber });
    console.log("User found:", !!user);

    if (!user) {
      console.log("❌ User not found");
      return;
    }

    console.log("User details:");
    console.log("  Name:", user.name);
    console.log("  Phone:", user.phoneNumber);
    console.log("  Password hash exists:", !!user.password);
    console.log("  Password hash length:", user.password?.length);

    console.log("\nComparing password...");
    const passwordMatch = await bcrypt.compare(password, user.password);
    console.log("Password matches:", passwordMatch);

    if (!user || !passwordMatch) {
      console.log("❌ Authentication failed - wrong credentials");
      return;
    }

    console.log("✅ User authenticated successfully");
    console.log("  isDisabled:", user.isDisabled);
    console.log("  isPasswordSet:", user.isPasswordSet);

  } catch (error) {
    console.error("❌ Error:", error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
  }
}

testLogin();





