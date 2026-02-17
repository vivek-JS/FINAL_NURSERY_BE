import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "./models/user.model.js";

const MONGO_URL = "mongodb+srv://vivekcreact_db_user:Vivek006%40%23@ram.tddrg8s.mongodb.net/?appName=Ram";

const verifyUser = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(MONGO_URL);
    console.log("✅ Connected to database");

    const phoneNumber = 7588686452;
    const password = "12345";

    // Find the user
    const user = await User.findOne({ phoneNumber: phoneNumber });
    
    if (!user) {
      console.log("❌ User not found!");
      return;
    }

    console.log("✅ User found!");
    console.log("User details:", {
      _id: user._id,
      name: user.name,
      phoneNumber: user.phoneNumber,
      role: user.role,
      jobTitle: user.jobTitle,
      isDisabled: user.isDisabled,
      isPasswordSet: user.isPasswordSet,
      isOnboarded: user.isOnboarded,
      passwordHash: user.password ? `${user.password.substring(0, 20)}...` : "NO PASSWORD",
      passwordLength: user.password ? user.password.length : 0
    });

    // Test password comparison
    if (user.password) {
      console.log("\n🔐 Testing password verification...");
      const passwordMatch = await bcrypt.compare(password, user.password);
      console.log(`Password match result: ${passwordMatch}`);
      
      if (!passwordMatch) {
        console.log("\n⚠️  Password does not match! Re-hashing password...");
        const newHashedPassword = await bcrypt.hash(password, 10);
        user.password = newHashedPassword;
        user.isPasswordSet = true;
        await user.save();
        console.log("✅ Password updated successfully!");
        
        // Test again
        const newPasswordMatch = await bcrypt.compare(password, user.password);
        console.log(`New password match result: ${newPasswordMatch}`);
      } else {
        console.log("✅ Password verification successful!");
      }
    } else {
      console.log("❌ User has no password set!");
      const hashedPassword = await bcrypt.hash(password, 10);
      user.password = hashedPassword;
      user.isPasswordSet = true;
      await user.save();
      console.log("✅ Password set successfully!");
    }

  } catch (error) {
    console.error("❌ Error:", error.message);
    console.error(error);
  } finally {
    await mongoose.disconnect();
    console.log("\nDisconnected from database");
    process.exit(0);
  }
};

// Run the script
verifyUser();





