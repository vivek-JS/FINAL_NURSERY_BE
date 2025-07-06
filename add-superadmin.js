import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
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
      const hashedPassword = await bcrypt.hash("passsword123443", 10);
      existingUser.role = "SUPER_ADMIN";
      existingUser.jobTitle = "OFFICE_ADMIN";
      existingUser.password = hashedPassword;
      await existingUser.save();
      console.log("✅ Updated existing user to SUPER_ADMIN role with new password");
      console.log("Password: passsword123443");
      
      return;
    }

    // Hash password
    const hashedPassword = await bcrypt.hash("passsword123443", 10);

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
    console.log("Password: passsword123443");

  } catch (error) {
    console.error("❌ Error creating super admin:", error.message);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from database");
  }
};

const addAnotherSuperAdmin = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URL);
    console.log("Connected to database");

    // Check if superadmin already exists
    const existingUser = await User.findOne({ phoneNumber: 1122334455 });
    
    if (existingUser) {
      console.log("User with phone number 1122334455 already exists!");
      console.log("User details:", {
        name: existingUser.name,
        phoneNumber: existingUser.phoneNumber,
        role: existingUser.role,
        jobTitle: existingUser.jobTitle
      });
      // Update existing user to superadmin and password
      const hashedPassword = await bcrypt.hash("passsword123443", 10);
      existingUser.role = "SUPER_ADMIN";
      existingUser.jobTitle = "OFFICE_ADMIN";
      existingUser.password = hashedPassword;
      await existingUser.save();
      console.log("✅ Updated existing user to SUPER_ADMIN role with new password");
      console.log("Password: passsword123443");
      return;
    }

    // Hash password
    const hashedPassword = await bcrypt.hash("432100", 10);

    // Create superadmin user
    const superAdmin = new User({
      name: "Super Admin 2",
      phoneNumber: 1122334455,
      password: hashedPassword,
      role: "SUPER_ADMIN",
      jobTitle: "OFFICE_ADMIN",
      isDisabled: false,
      isOnboarded: true
    });

    await superAdmin.save();
    
    console.log("✅ Super Admin 2 created successfully!");
    console.log("User details:", {
      name: superAdmin.name,
      phoneNumber: superAdmin.phoneNumber,
      role: superAdmin.role,
      jobTitle: superAdmin.jobTitle
    });
    console.log("Password: 432100");

  } catch (error) {
    console.error("❌ Error creating super admin 2:", error.message);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from database");
  }
};

// Run the script
addSuperAdmin(); 
// Run the script for the new super admin
addAnotherSuperAdmin(); 