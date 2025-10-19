import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import User from "./models/user.model.js";

// Load environment variables
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/nursery";

async function resetDispatchManagerPasswords() {
  try {
    console.log("===========================================");
    console.log("Reset Dispatch Manager Passwords to 1234");
    console.log("===========================================\n");

    // Connect to MongoDB
    console.log("Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB successfully\n");

    // Default password
    const DEFAULT_PASSWORD = "1234";
    
    // Hash the default password
    console.log("Hashing password...");
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, salt);
    console.log("✓ Password hashed successfully\n");

    // Find all dispatch managers (active and not disabled)
    console.log("Finding all dispatch managers...");
    const dispatchManagers = await User.find({
      $or: [
        { role: 'DISPATCH_MANAGER' },
        { jobTitle: 'DISPATCH_MANAGER' }
      ],
      isDisabled: { $ne: true }
    });

    console.log(`✓ Found ${dispatchManagers.length} dispatch manager(s)\n`);

    if (dispatchManagers.length === 0) {
      console.log("⚠ No active dispatch managers found in the database");
      await mongoose.connection.close();
      return;
    }

    console.log("Dispatch Managers to be updated:");
    console.log("--------------------------------");
    dispatchManagers.forEach((manager, index) => {
      console.log(`${index + 1}. Name: ${manager.name}, Phone: ${manager.phoneNumber}, Role: ${manager.role || manager.jobTitle}`);
    });
    console.log("");

    // Update all dispatch manager passwords
    console.log("Updating passwords...");
    const updatePromises = dispatchManagers.map(manager => 
      User.findByIdAndUpdate(
        manager._id,
        {
          password: hashedPassword,
          isPasswordSet: false // Force password change on next login
        },
        { new: true }
      )
    );

    await Promise.all(updatePromises);
    console.log("✓ All passwords updated successfully\n");

    console.log("===========================================");
    console.log("✓ SUCCESS!");
    console.log("===========================================");
    console.log(`Updated ${dispatchManagers.length} dispatch manager password(s) to: ${DEFAULT_PASSWORD}`);
    console.log("Note: Users will be required to change their password on next login");
    console.log("");

    // Close connection
    await mongoose.connection.close();
    console.log("✓ MongoDB connection closed");
    
  } catch (error) {
    console.error("\n❌ ERROR:", error.message);
    console.error(error);
    
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
    }
    
    process.exit(1);
  }
}

// Run the script
resetDispatchManagerPasswords();

