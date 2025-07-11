import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import User from "./models/user.model.js";
import bcrypt from "bcryptjs";

async function debugLogin() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URL);
    console.log("Connected to MongoDB successfully");

    console.log("Environment variables:");
    console.log("MONGO_URL:", process.env.MONGO_URL ? "Set" : "Not set");
    console.log("JWT_SECRET:", process.env.JWT_SECRET ? "Set" : "Not set");
    console.log("PORT:", process.env.PORT);

    const phoneNumber = 7588686452;
    console.log(`\nLooking for user with phone number: ${phoneNumber}`);

    const user = await User.findOne({ phoneNumber: phoneNumber });
    
    if (user) {
      console.log("User found:", {
        _id: user._id,
        name: user.name,
        phoneNumber: user.phoneNumber,
        role: user.role,
        isDisabled: user.isDisabled
      });

      const password = "passsword123443";
      console.log(`\nTesting password: ${password}`);
      
      const isPasswordValid = await bcrypt.compare(password, user.password);
      console.log("Password valid:", isPasswordValid);

      if (isPasswordValid) {
        console.log("Login should succeed!");
      } else {
        console.log("Login should fail - wrong password");
      }
    } else {
      console.log("User not found!");
    }

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

debugLogin(); 