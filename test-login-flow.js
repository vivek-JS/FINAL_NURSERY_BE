import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import User from "./models/user.model.js";
import bcrypt from "bcryptjs";
import { generateTokenPair } from "./utility/jwtUtils.js";
import generateResponse from "./utility/responseFormat.js";

async function testLoginFlow() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URL);
    console.log("Connected to MongoDB successfully");

    const phoneNumber = 7588686452;
    const password = "passsword123443";

    console.log(`\nLooking for user with phone number: ${phoneNumber}`);
    const user = await User.findOne({ phoneNumber: phoneNumber });

    if (!user) {
      console.log("User not found!");
      return;
    }

    console.log("User found:", {
      _id: user._id,
      name: user.name,
      phoneNumber: user.phoneNumber,
      role: user.role,
      isDisabled: user.isDisabled
    });

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    console.log("Password valid:", isPasswordValid);

    if (!isPasswordValid) {
      console.log("Login should fail - wrong password");
      return;
    }

    // Check if user is disabled
    if (user.isDisabled) {
      console.log("Login should fail - user is disabled");
      return;
    }

    console.log("Password and user status are valid, proceeding to token generation...");

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    console.log("User response object:", userResponse);

    // Generate token pair
    console.log("Generating token pair...");
    const tokenPair = generateTokenPair({
      _id: user._id.toString(),
      phoneNumber: user.phoneNumber,
      role: user.role,
      name: user.name
    });

    console.log("Token pair generated successfully!");
    console.log("Access token length:", tokenPair.accessToken.length);
    console.log("Refresh token length:", tokenPair.refreshToken.length);

    // Test response generation
    console.log("Generating response...");
    const response = generateResponse(
      "Success",
      "Login successful - Token generated successfully",
      {
        user: userResponse,
        accessToken: tokenPair.accessToken,
        refreshToken: tokenPair.refreshToken,
        expiresIn: tokenPair.expiresIn,
        message: "Access token generated and ready for API calls"
      },
      undefined
    );

    console.log("Response generated successfully!");
    console.log("Response status:", response.status);
    console.log("Response message:", response.message);

    console.log("Login flow test completed successfully!");

  } catch (error) {
    console.error("Login Flow Error:", error);
    console.error("Error Stack:", error.stack);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

testLoginFlow(); 