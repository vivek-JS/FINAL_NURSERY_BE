import dotenv from "dotenv";
dotenv.config();
import { generateTokenPair } from "./utility/jwtUtils.js";

async function testJWT() {
  try {
    console.log("Testing JWT generation...");
    console.log("Environment variables:");
    console.log("JWT_SECRET:", process.env.JWT_SECRET ? "Set" : "Not set");
    console.log("ACCESS_TOKEN_EXPIRY:", process.env.ACCESS_TOKEN_EXPIRY || "15m");
    console.log("REFRESH_TOKEN_SECRET:", process.env.REFRESH_TOKEN_SECRET ? "Set" : "Not set");
    
    const payload = {
      _id: "6869ff079e52efe6184aec3a",
      phoneNumber: 7588686452,
      role: "SUPER_ADMIN",
      name: "Super Admin"
    };
    
    console.log("Payload:", payload);
    
    const tokenPair = generateTokenPair(payload);
    console.log("Token generation successful!");
    console.log("Access token length:", tokenPair.accessToken.length);
    console.log("Refresh token length:", tokenPair.refreshToken.length);
    
  } catch (error) {
    console.error("JWT Generation Error:", error);
    console.error("Error Stack:", error.stack);
  }
}

testJWT(); 