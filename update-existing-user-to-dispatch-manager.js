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

// Update existing user to DISPATCH_MANAGER
const updateExistingUserToDispatchManager = async () => {
  try {
    const phoneNumber = 7218186452;
    
    console.log(`🔍 Looking for existing user with phone number: ${phoneNumber}`);
    
    // Find the user by phone number
    const user = await User.findOne({ phoneNumber: phoneNumber });
    
    if (!user) {
      console.log(`❌ User with phone number ${phoneNumber} not found`);
      console.log(`🔍 Let me check all users to see what's available...`);
      
      // List all users to see what exists
      const allUsers = await User.find({}).select('name phoneNumber role jobTitle');
      console.log(`📋 Found ${allUsers.length} users in database:`);
      allUsers.forEach((u, index) => {
        console.log(`   ${index + 1}. ${u.name} - ${u.phoneNumber} (${u.role}/${u.jobTitle})`);
      });
      return;
    }
    
    console.log(`📋 Found existing user:`);
    console.log(`   Name: ${user.name}`);
    console.log(`   Phone: ${user.phoneNumber}`);
    console.log(`   Current Role: ${user.role}`);
    console.log(`   Current Job Title: ${user.jobTitle}`);
    console.log(`   Is Onboarded: ${user.isOnboarded}`);
    
    // Update the user's role and job title
    const oldRole = user.role;
    const oldJobTitle = user.jobTitle;
    
    user.role = "DISPATCH_MANAGER";
    user.jobTitle = "DISPATCH_MANAGER";
    
    // Save the updated user
    await user.save();
    
    console.log(`\n✅ Successfully updated user to DISPATCH_MANAGER`);
    console.log(`📋 Changes made:`);
    console.log(`   Role: ${oldRole} → ${user.role}`);
    console.log(`   Job Title: ${oldJobTitle} → ${user.jobTitle}`);
    
    // Verify the update
    const updatedUser = await User.findOne({ phoneNumber: phoneNumber });
    console.log(`\n🔍 Final verification:`);
    console.log(`   Name: ${updatedUser.name}`);
    console.log(`   Phone: ${updatedUser.phoneNumber}`);
    console.log(`   Role: ${updatedUser.role}`);
    console.log(`   Job Title: ${updatedUser.jobTitle}`);
    console.log(`   Is Onboarded: ${updatedUser.isOnboarded}`);
    
    console.log(`\n🎉 User is now ready to use Dispatch Manager features!`);
    
  } catch (error) {
    console.error("❌ Error updating user:", error);
  }
};

// Main function
const main = async () => {
  await connectDB();
  await updateExistingUserToDispatchManager();
  await mongoose.connection.close();
  console.log("👋 Database connection closed");
};

// Run the script
main().catch(console.error);
