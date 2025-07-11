import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";

const testConnection = async () => {
  console.log("Testing MongoDB connection...");
  console.log("MONGO_URL:", process.env.MONGO_URL ? "Set" : "Not set");
  console.log("NODE_ENV:", process.env.NODE_ENV);
  console.log("PORT:", process.env.PORT);
  
  try {
    // Set connection options for better reliability
    const options = {
      serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
      socketTimeoutMS: 45000, // Close sockets after 45s of inactivity
      maxPoolSize: 10, // Maintain up to 10 socket connections
      minPoolSize: 1, // Maintain at least 1 socket connection
    };

    console.log("Attempting to connect...");
    await mongoose.connect(process.env.MONGO_URL, options);
    console.log("✅ Successfully connected to MongoDB!");
    
    // Test a simple query
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log("Available collections:", collections.map(c => c.name));
    
    await mongoose.disconnect();
    console.log("✅ Connection test completed successfully!");
    
  } catch (error) {
    console.error("❌ MongoDB connection failed:");
    console.error("Error:", error.message);
    console.error("Code:", error.code);
    
    if (error.message.includes("buffering timed out")) {
      console.log("\n🔧 Troubleshooting tips:");
      console.log("1. Check if MONGO_URL is correct");
      console.log("2. Ensure MongoDB Atlas IP whitelist includes Render's IP");
      console.log("3. Verify username/password in connection string");
      console.log("4. Check if MongoDB service is running");
    }
    
    process.exit(1);
  }
};

testConnection(); 