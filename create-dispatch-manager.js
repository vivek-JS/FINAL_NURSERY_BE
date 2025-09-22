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

// Create dispatch manager users
const createDispatchManagers = async () => {
  try {
    console.log("🚀 Creating Dispatch Manager users...");

    const dispatchManagers = [
      {
        name: "Rajesh Kumar",
        phoneNumber: 9876543200,
        password: "12345678",
        jobTitle: "DISPATCH_MANAGER",
        role: "DISPATCH_MANAGER",
        isPasswordSet: false,
        isOnboarded: true,
        defaultState: "Maharashtra",
        defaultDistrict: "Pune",
        defaultTaluka: "Pune",
        defaultVillage: "Pune"
      },
      {
        name: "Priya Sharma",
        phoneNumber: 9876543201,
        password: "12345678",
        jobTitle: "DISPATCH_MANAGER",
        role: "DISPATCH_MANAGER",
        isPasswordSet: false,
        isOnboarded: true,
        defaultState: "Maharashtra",
        defaultDistrict: "Mumbai",
        defaultTaluka: "Mumbai",
        defaultVillage: "Mumbai"
      }
    ];

    for (const managerData of dispatchManagers) {
      // Check if user already exists
      const existingUser = await User.findOne({ phoneNumber: managerData.phoneNumber });
      
      if (existingUser) {
        console.log(`⚠️  User with phone ${managerData.phoneNumber} already exists`);
        continue;
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(managerData.password, 12);

      // Create user
      const user = new User({
        ...managerData,
        password: hashedPassword
      });

      await user.save();
      console.log(`✅ Created Dispatch Manager: ${managerData.name} (${managerData.phoneNumber})`);
    }

    console.log("🎉 Dispatch Manager users created successfully!");
    console.log("\n📱 Login Credentials:");
    console.log("Dispatch Manager 1: Phone: 9876543200, Password: 12345678");
    console.log("Dispatch Manager 2: Phone: 9876543201, Password: 12345678");

  } catch (error) {
    console.error("❌ Error creating dispatch managers:", error);
  }
};

// Main function
const main = async () => {
  await connectDB();
  await createDispatchManagers();
  await mongoose.connection.close();
  console.log("👋 Database connection closed");
};

// Run the script
main().catch(console.error);
