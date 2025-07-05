import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import User from "./models/user.model.js";

dotenv.config();

const addSuperAdmin = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URL);
    console.log("Connected to database");

    // Check if superadmin already exists
    const existingUser = await User.findOne({ phoneNumber: 7588686452 });
    
        if (existingUser) {
      console.log("User with phone number 7588686452 already exists!");
      console.log("User details:", {
        name: existingUser.name,
        phoneNumber: existingUser.phoneNumber,
        role: existingUser.role,
        jobTitle: existingUser.jobTitle
      });
      
      // Update existing user to superadmin and password
      const hashedPassword = await bcrypt.hash("432100", 10);
      existingUser.role = "SUPER_ADMIN";
      existingUser.jobTitle = "OFFICE_ADMIN";
      existingUser.password = hashedPassword;
      await existingUser.save();
      console.log("✅ Updated existing user to SUPER_ADMIN role with new password");
      console.log("Password: 432100");
      
      return;
    }

    // Hash password
    const hashedPassword = await bcrypt.hash("432100", 10);

    // Create superadmin user
    const superAdmin = new User({
      name: "Super Admin",
      phoneNumber: 7588686452,
      password: hashedPassword,
      role: "SUPER_ADMIN",
      jobTitle: "OFFICE_ADMIN", // Using valid enum value
      isDisabled: false,
      isOnboarded: true
    });

    await superAdmin.save();
    
    console.log("✅ Super Admin created successfully!");
    console.log("User details:", {
      name: superAdmin.name,
      phoneNumber: superAdmin.phoneNumber,
      role: superAdmin.role,
      jobTitle: superAdmin.jobTitle
    });
    console.log("Password: 432100");

  } catch (error) {
    console.error("❌ Error creating super admin:", error.message);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from database");
  }
};

// Run the script
addSuperAdmin(); 