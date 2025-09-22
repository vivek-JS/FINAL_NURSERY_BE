import mongoose from "mongoose";
import User from "./models/user.model.js";

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/nursery-management");
    console.log("✅ Connected to MongoDB");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  }
};

// Update user to DISPATCH_MANAGER
const updateUserToDispatchManager = async () => {
  try {
    const phoneNumber = 7218186452;
    
    console.log(`🔍 Looking for user with phone number: ${phoneNumber}`);
    
    // Find the user by phone number
    const user = await User.findOne({ phoneNumber: phoneNumber });
    
    if (!user) {
      console.log(`❌ User with phone number ${phoneNumber} not found`);
      return;
    }
    
    console.log(`📋 Found user: ${user.name} (${user.phoneNumber})`);
    console.log(`📋 Current role: ${user.role}`);
    console.log(`📋 Current job title: ${user.jobTitle}`);
    
    // Update the user's role and job title
    user.role = "DISPATCH_MANAGER";
    user.jobTitle = "DISPATCH_MANAGER";
    
    // Save the updated user
    await user.save();
    
    console.log(`✅ Successfully updated user to DISPATCH_MANAGER`);
    console.log(`📋 New role: ${user.role}`);
    console.log(`📋 New job title: ${user.jobTitle}`);
    
    // Verify the update
    const updatedUser = await User.findOne({ phoneNumber: phoneNumber });
    console.log(`🔍 Verification - Updated user details:`);
    console.log(`   Name: ${updatedUser.name}`);
    console.log(`   Phone: ${updatedUser.phoneNumber}`);
    console.log(`   Role: ${updatedUser.role}`);
    console.log(`   Job Title: ${updatedUser.jobTitle}`);
    console.log(`   Is Onboarded: ${updatedUser.isOnboarded}`);
    
  } catch (error) {
    console.error("❌ Error updating user:", error);
  }
};

// Main function
const main = async () => {
  await connectDB();
  await updateUserToDispatchManager();
  await mongoose.connection.close();
  console.log("👋 Database connection closed");
};

// Run the script
main().catch(console.error);
