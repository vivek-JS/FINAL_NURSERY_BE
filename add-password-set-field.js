import mongoose from "mongoose"
import User from "./models/user.model.js"
import dotenv from "dotenv"

// Load environment variables
dotenv.config()

const updateUsersWithPasswordSet = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URL)
    console.log("Connected to MongoDB")

    // Update all existing users to have isPasswordSet: true
    // This assumes existing users already have passwords set
    const result = await User.updateMany(
      { isPasswordSet: { $exists: false } }, // Only update users without the field
      { $set: { isPasswordSet: true } }
    )

    console.log(`Updated ${result.modifiedCount} users with isPasswordSet: true`)

    // Also update users with default password "12345678" to have isPasswordSet: false
    const defaultPasswordResult = await User.updateMany(
      { password: "12345678", isPasswordSet: true },
      { $set: { isPasswordSet: false } }
    )

    console.log(`Updated ${defaultPasswordResult.modifiedCount} users with default password to isPasswordSet: false`)

    // Get total count of users
    const totalUsers = await User.countDocuments()
    console.log(`Total users in database: ${totalUsers}`)

    // Get count of users with isPasswordSet: false
    const usersWithDefaultPassword = await User.countDocuments({ isPasswordSet: false })
    console.log(`Users with default password (isPasswordSet: false): ${usersWithDefaultPassword}`)

    console.log("Database update completed successfully")
  } catch (error) {
    console.error("Error updating users:", error)
  } finally {
    await mongoose.disconnect()
    console.log("Disconnected from MongoDB")
  }
}

// Run the script
updateUsersWithPasswordSet() 