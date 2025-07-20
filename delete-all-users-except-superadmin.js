import mongoose from "mongoose"
import bcrypt from "bcryptjs"
import dotenv from "dotenv"
import User from "./models/user.model.js"

// Load environment variables
dotenv.config()

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL)
    console.log("✅ Connected to MongoDB")
  } catch (error) {
    console.error("❌ MongoDB connection error:", error.message)
    process.exit(1)
  }
}

// Disconnect from MongoDB
const disconnectDB = async () => {
  try {
    await mongoose.disconnect()
    console.log("✅ Disconnected from MongoDB")
  } catch (error) {
    console.error("❌ Error disconnecting from MongoDB:", error.message)
  }
}

// Delete all users except super admin
const deleteAllUsersExceptSuperAdmin = async () => {
  try {
    console.log("🔍 Starting user cleanup process...")
    
    // First, let's find the super admin user
    const superAdmin = await User.findOne({ role: "SUPER_ADMIN" })
    
    if (!superAdmin) {
      console.log("⚠️  No Super Admin found in the system!")
      console.log("This script will delete ALL users. Are you sure you want to continue?")
      console.log("Press Ctrl+C to cancel or wait 10 seconds to continue...")
      
      // Wait 10 seconds for user to cancel
      await new Promise(resolve => setTimeout(resolve, 10000))
    } else {
      console.log("✅ Found Super Admin:")
      console.log(`   Name: ${superAdmin.name}`)
      console.log(`   Phone: ${superAdmin.phoneNumber}`)
      console.log(`   Role: ${superAdmin.role}`)
      console.log(`   Job Title: ${superAdmin.jobTitle}`)
    }

    // Get counts before deletion
    const totalUsers = await User.countDocuments()
    const superAdminCount = await User.countDocuments({ role: "SUPER_ADMIN" })
    const otherUsersCount = totalUsers - superAdminCount

    console.log("\n📊 Current User Statistics:")
    console.log(`   Total Users: ${totalUsers}`)
    console.log(`   Super Admins: ${superAdminCount}`)
    console.log(`   Other Users: ${otherUsersCount}`)

    if (otherUsersCount === 0) {
      console.log("✅ No users to delete. Only Super Admin(s) exist.")
      return
    }

    // Show what will be deleted
    console.log("\n🗑️  Users that will be deleted:")
    const usersToDelete = await User.find({ role: { $ne: "SUPER_ADMIN" } })
      .select("name phoneNumber role jobTitle")
      .sort({ role: 1, name: 1 })

    usersToDelete.forEach((user, index) => {
      console.log(`   ${index + 1}. ${user.name} (${user.phoneNumber}) - ${user.role}${user.jobTitle ? ` - ${user.jobTitle}` : ""}`)
    })

    // Confirmation prompt
    console.log("\n⚠️  WARNING: This action cannot be undone!")
    console.log(`   ${otherUsersCount} users will be permanently deleted.`)
    console.log("   Press Ctrl+C to cancel or wait 15 seconds to continue...")
    
    // Wait 15 seconds for user to cancel
    await new Promise(resolve => setTimeout(resolve, 15000))

    // Proceed with deletion
    console.log("\n🗑️  Starting deletion process...")
    
    const deleteResult = await User.deleteMany({ role: { $ne: "SUPER_ADMIN" } })
    
    console.log("✅ Deletion completed!")
    console.log(`   Deleted ${deleteResult.deletedCount} users`)

    // Verify results
    const remainingUsers = await User.countDocuments()
    const remainingSuperAdmins = await User.countDocuments({ role: "SUPER_ADMIN" })
    
    console.log("\n📊 Final User Statistics:")
    console.log(`   Total Users Remaining: ${remainingUsers}`)
    console.log(`   Super Admins Remaining: ${remainingSuperAdmins}`)
    console.log(`   Other Users Remaining: ${remainingUsers - remainingSuperAdmins}`)

    if (remainingSuperAdmins > 0) {
      const remainingSuperAdminList = await User.find({ role: "SUPER_ADMIN" })
        .select("name phoneNumber role jobTitle")
      
      console.log("\n👑 Remaining Super Admin(s):")
      remainingSuperAdminList.forEach((admin, index) => {
        console.log(`   ${index + 1}. ${admin.name} (${admin.phoneNumber}) - ${admin.role}${admin.jobTitle ? ` - ${admin.jobTitle}` : ""}`)
      })
    }

    console.log("\n✅ User cleanup process completed successfully!")

  } catch (error) {
    console.error("❌ Error during user cleanup:", error.message)
    throw error
  }
}

// Main execution
const main = async () => {
  try {
    await connectDB()
    await deleteAllUsersExceptSuperAdmin()
  } catch (error) {
    console.error("❌ Script failed:", error.message)
    process.exit(1)
  } finally {
    await disconnectDB()
  }
}

// Run the script
main() 