import mongoose from "mongoose";
import User from "./models/user.model.js";
import bcrypt from "bcryptjs";

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

// Check and create/update user to DISPATCH_MANAGER
const checkAndCreateDispatchManager = async () => {
  try {
    const phoneNumber = 7218186452;
    
    console.log(`🔍 Looking for user with phone number: ${phoneNumber}`);
    
    // Find the user by phone number
    let user = await User.findOne({ phoneNumber: phoneNumber });
    
    if (!user) {
      console.log(`❌ User with phone number ${phoneNumber} not found`);
      console.log(`🔍 Let me check all users to see what's available...`);
      
      // List all users to see what exists
      const allUsers = await User.find({}).select('name phoneNumber role jobTitle');
      console.log(`📋 Found ${allUsers.length} users in database:`);
      allUsers.forEach((u, index) => {
        console.log(`   ${index + 1}. ${u.name} - ${u.phoneNumber} (${u.role}/${u.jobTitle})`);
      });
      
      console.log(`\n🆕 Creating new user with phone number ${phoneNumber}...`);
      
      // Create new user
      const hashedPassword = await bcrypt.hash("1234", 12);
      
      user = new User({
        name: "Dispatch Manager",
        phoneNumber: phoneNumber,
        password: hashedPassword,
        role: "DISPATCH_MANAGER",
        jobTitle: "DISPATCH_MANAGER",
        isPasswordSet: false,
        isOnboarded: true,
        defaultState: "Maharashtra",
        defaultDistrict: "Pune",
        defaultTaluka: "Pune",
        defaultVillage: "Pune"
      });
      
      await user.save();
      console.log(`✅ Created new DISPATCH_MANAGER user: ${user.name} (${user.phoneNumber})`);
      
    } else {
      console.log(`📋 Found existing user: ${user.name} (${user.phoneNumber})`);
      console.log(`📋 Current role: ${user.role}`);
      console.log(`📋 Current job title: ${user.jobTitle}`);
      
      // Update the user's role and job title
      user.role = "DISPATCH_MANAGER";
      user.jobTitle = "DISPATCH_MANAGER";
      
      // Save the updated user
      await user.save();
      
      console.log(`✅ Successfully updated user to DISPATCH_MANAGER`);
    }
    
    // Verify the final state
    const finalUser = await User.findOne({ phoneNumber: phoneNumber });
    console.log(`\n🔍 Final verification:`);
    console.log(`   Name: ${finalUser.name}`);
    console.log(`   Phone: ${finalUser.phoneNumber}`);
    console.log(`   Role: ${finalUser.role}`);
    console.log(`   Job Title: ${finalUser.jobTitle}`);
    console.log(`   Is Onboarded: ${finalUser.isOnboarded}`);
    console.log(`   Password: 1234 (default)`);
    
  } catch (error) {
    console.error("❌ Error updating/creating user:", error);
  }
};

// Main function
const main = async () => {
  await connectDB();
  await checkAndCreateDispatchManager();
  await mongoose.connection.close();
  console.log("👋 Database connection closed");
};

// Run the script
main().catch(console.error);
