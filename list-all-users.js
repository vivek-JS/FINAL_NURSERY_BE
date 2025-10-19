import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "./models/user.model.js";

// Load environment variables
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/nursery";

async function listAllUsers() {
  try {
    console.log("===========================================");
    console.log("List All Users in Database");
    console.log("===========================================\n");

    // Connect to MongoDB
    console.log("Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB successfully\n");

    // Find all users
    const users = await User.find({}).select('name phoneNumber role jobTitle isDisabled isPasswordSet');
    
    console.log(`Total users in database: ${users.length}\n`);
    
    if (users.length === 0) {
      console.log("⚠️  No users found in database");
      console.log("\nTo create a user, you can:");
      console.log("1. Use the API: POST /api/user/createUser");
      console.log("2. Run existing scripts like:");
      console.log("   - create-dispatch-manager.js");
      console.log("   - add-superadmin.js");
      console.log("   - etc.");
    } else {
      console.log("Users List:");
      console.log("═══════════════════════════════════════════════════════════════════\n");
      
      users.forEach((user, index) => {
        console.log(`${index + 1}. ${user.name}`);
        console.log(`   Phone:        ${user.phoneNumber}`);
        console.log(`   Role:         ${user.role || 'N/A'}`);
        console.log(`   Job Title:    ${user.jobTitle || 'N/A'}`);
        console.log(`   Disabled:     ${user.isDisabled ? 'Yes ❌' : 'No ✓'}`);
        console.log(`   Password Set: ${user.isPasswordSet ? 'Yes ✓' : 'No (needs reset)'}`);
        console.log("");
      });
      
      console.log("═══════════════════════════════════════════════════════════════════");
      
      // Group by role
      const roleGroups = {};
      users.forEach(user => {
        const role = user.role || user.jobTitle || 'NO_ROLE';
        if (!roleGroups[role]) roleGroups[role] = [];
        roleGroups[role].push(user);
      });
      
      console.log("\nSummary by Role:");
      console.log("═══════════════════════════════════════════════════════════════════");
      Object.keys(roleGroups).sort().forEach(role => {
        console.log(`${role}: ${roleGroups[role].length} user(s)`);
      });
      console.log("═══════════════════════════════════════════════════════════════════");
    }

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
listAllUsers();

