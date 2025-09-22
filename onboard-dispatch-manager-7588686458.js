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

// Onboard new DISPATCH_MANAGER user
const onboardDispatchManager = async () => {
  try {
    const phoneNumber = 7588686458;
    const name = "Dispatch Manager 7588686458";
    const password = "12345678"; // Default password as per memory
    
    console.log(`🔍 Checking if user with phone number ${phoneNumber} already exists...`);
    
    // Check if user already exists
    let existingUser = await User.findOne({ phoneNumber: phoneNumber });
    
    if (existingUser) {
      console.log(`📋 User already exists:`);
      console.log(`   Name: ${existingUser.name}`);
      console.log(`   Phone: ${existingUser.phoneNumber}`);
      console.log(`   Current Role: ${existingUser.role}`);
      console.log(`   Current Job Title: ${existingUser.jobTitle}`);
      console.log(`   Is Onboarded: ${existingUser.isOnboarded}`);
      
      // Update existing user to DISPATCH_MANAGER
      const oldRole = existingUser.role;
      const oldJobTitle = existingUser.jobTitle;
      
      existingUser.role = "DISPATCH_MANAGER";
      existingUser.jobTitle = "DISPATCH_MANAGER";
      existingUser.isOnboarded = true;
      existingUser.isPasswordSet = true;
      
      // Hash the password if it's not already hashed
      if (!existingUser.password.startsWith('$2')) {
        existingUser.password = await bcrypt.hash(password, 12);
      }
      
      await existingUser.save();
      
      console.log(`\n✅ Updated existing user to DISPATCH_MANAGER`);
      console.log(`📋 Changes made:`);
      console.log(`   Role: ${oldRole} → ${existingUser.role}`);
      console.log(`   Job Title: ${oldJobTitle} → ${existingUser.jobTitle}`);
      console.log(`   Is Onboarded: ${existingUser.isOnboarded}`);
      
    } else {
      console.log(`👤 Creating new DISPATCH_MANAGER user...`);
      
      // Hash the password
      const hashedPassword = await bcrypt.hash(password, 12);
      
      // Create new user
      const newUser = new User({
        name: name,
        phoneNumber: phoneNumber,
        password: hashedPassword,
        role: "DISPATCH_MANAGER",
        jobTitle: "DISPATCH_MANAGER",
        isOnboarded: true,
        isPasswordSet: true,
        createdAt: new Date(),
        updatedAt: new Date()
      });
      
      await newUser.save();
      
      console.log(`\n✅ Successfully created new DISPATCH_MANAGER user`);
      console.log(`📋 User details:`);
      console.log(`   Name: ${newUser.name}`);
      console.log(`   Phone: ${newUser.phoneNumber}`);
      console.log(`   Role: ${newUser.role}`);
      console.log(`   Job Title: ${newUser.jobTitle}`);
      console.log(`   Is Onboarded: ${newUser.isOnboarded}`);
      console.log(`   Password: ${password} (default)`);
    }
    
    // Final verification
    const finalUser = await User.findOne({ phoneNumber: phoneNumber });
    console.log(`\n🔍 Final verification:`);
    console.log(`   Name: ${finalUser.name}`);
    console.log(`   Phone: ${finalUser.phoneNumber}`);
    console.log(`   Role: ${finalUser.role}`);
    console.log(`   Job Title: ${finalUser.jobTitle}`);
    console.log(`   Is Onboarded: ${finalUser.isOnboarded}`);
    console.log(`   Is Password Set: ${finalUser.isPasswordSet}`);
    
    console.log(`\n🎉 User ${phoneNumber} is now ready to use Dispatch Manager features!`);
    console.log(`📱 They can login with phone number: ${phoneNumber}`);
    console.log(`🔑 Default password: ${password}`);
    
  } catch (error) {
    console.error("❌ Error onboarding user:", error);
  }
};

// Main function
const main = async () => {
  await connectDB();
  await onboardDispatchManager();
  await mongoose.connection.close();
  console.log("👋 Database connection closed");
};

// Run the script
main().catch(console.error);
