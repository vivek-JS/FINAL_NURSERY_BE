import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import User from "./models/user.model.js";

async function listUsers() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URL);
    console.log("Connected to MongoDB successfully");

    const users = await User.find({}).select('name phoneNumber role isDisabled');
    
    console.log(`\nFound ${users.length} users in database:`);
    users.forEach((user, index) => {
      console.log(`${index + 1}. Name: ${user.name}, Phone: ${user.phoneNumber}, Role: ${user.role}, Disabled: ${user.isDisabled}`);
    });

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

listUsers(); 