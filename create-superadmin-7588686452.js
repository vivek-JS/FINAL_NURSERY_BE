import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "./models/user.model.js";

// Production-ready MongoDB connection options
const mongoOptions = {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 10000,
  maxPoolSize: 10,
  minPoolSize: 1,
  retryWrites: true,
  w: 'majority',
  retryReads: true,
};

const createSuperAdmin = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URL, mongoOptions);
    console.log("✅ Connected to database");
    console.log(`Database: ${mongoose.connection.db.databaseName}`);

    const phoneNumber = 7588686452;
    const password = "123321123";

    // Check if user already exists
    const existingUser = await User.findOne({ phoneNumber: phoneNumber });
    
    if (existingUser) {
      console.log(`⚠️  User with phone number ${phoneNumber} already exists!`);
      console.log("User details:", {
        name: existingUser.name,
        phoneNumber: existingUser.phoneNumber,
        role: existingUser.role,
        jobTitle: existingUser.jobTitle
      });
      
      // Update existing user to superadmin and password
      const hashedPassword = await bcrypt.hash(password, 10);
      existingUser.role = "SUPER_ADMIN";
      existingUser.jobTitle = "OFFICE_ADMIN";
      existingUser.password = hashedPassword;
      existingUser.isPasswordSet = true;
      existingUser.isDisabled = false;
      existingUser.isOnboarded = true;
      await existingUser.save();
      console.log("✅ Updated existing user to SUPER_ADMIN role with new password");
      console.log(`Password: ${password}`);
      
      return;
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create superadmin user
    const superAdmin = new User({
      name: "Super Admin",
      phoneNumber: phoneNumber,
      password: hashedPassword,
      role: "SUPER_ADMIN",
      jobTitle: "OFFICE_ADMIN",
      isPasswordSet: true,
      isDisabled: false,
      isOnboarded: true
    });

    await superAdmin.save();
    
    console.log("✅ Super Admin created successfully!");
    console.log("User details:", {
      name: superAdmin.name,
      phoneNumber: superAdmin.phoneNumber,
      role: superAdmin.role,
      jobTitle: superAdmin.jobTitle,
      isPasswordSet: superAdmin.isPasswordSet,
      isDisabled: superAdmin.isDisabled,
      isOnboarded: superAdmin.isOnboarded
    });
    console.log(`Password: ${password}`);

  } catch (error) {
    console.error("❌ Error creating super admin:", error.message);
    console.error(error);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from database");
    process.exit(0);
  }
};

// Run the script
createSuperAdmin();

