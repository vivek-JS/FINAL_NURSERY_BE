import mongoose from "mongoose"
import dotenv from "dotenv"
import User from "./models/user.model.js"
import Farmer from "./models/farmer.model.js"

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

// Delete all data except super admin
const deleteAllDataExceptSuperAdmin = async () => {
  try {
    console.log("🔍 Starting comprehensive data cleanup process...")
    console.log("This will delete ALL farmers and ALL employees except Super Admin")
    
    // First, let's find the super admin user
    const superAdmin = await User.findOne({ role: "SUPER_ADMIN" })
    
    if (!superAdmin) {
      console.log("⚠️  No Super Admin found in the system!")
      console.log("This script will delete ALL users. Are you sure you want to continue?")
      console.log("Press Ctrl+C to cancel or wait 15 seconds to continue...")
      
      // Wait 15 seconds for user to cancel
      await new Promise(resolve => setTimeout(resolve, 15000))
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
    const totalFarmers = await Farmer.countDocuments()

    console.log("\n📊 Current Data Statistics:")
    console.log(`   Total Users: ${totalUsers}`)
    console.log(`   Super Admins: ${superAdminCount}`)
    console.log(`   Other Users (Employees): ${otherUsersCount}`)
    console.log(`   Total Farmers: ${totalFarmers}`)
    console.log(`   Total Records to Delete: ${otherUsersCount + totalFarmers}`)

    if (otherUsersCount === 0 && totalFarmers === 0) {
      console.log("✅ No data to delete. Only Super Admin exists.")
      return
    }

    // Show what will be deleted
    if (otherUsersCount > 0) {
      console.log("\n🗑️  Users that will be deleted:")
      const usersToDelete = await User.find({ role: { $ne: "SUPER_ADMIN" } })
        .select("name phoneNumber role jobTitle")
        .sort({ role: 1, name: 1 })
        .limit(15) // Show first 15 for preview

      usersToDelete.forEach((user, index) => {
        console.log(`   ${index + 1}. ${user.name} (${user.phoneNumber}) - ${user.role}${user.jobTitle ? ` - ${user.jobTitle}` : ""}`)
      })

      if (otherUsersCount > 15) {
        console.log(`   ... and ${otherUsersCount - 15} more users`)
      }
    }

    if (totalFarmers > 0) {
      console.log("\n🗑️  Farmers that will be deleted:")
      const farmersToDelete = await Farmer.find({})
        .select("name mobileNumber village taluka district")
        .sort({ name: 1 })
        .limit(15) // Show first 15 for preview

      farmersToDelete.forEach((farmer, index) => {
        console.log(`   ${index + 1}. ${farmer.name} (${farmer.mobileNumber}) - ${farmer.village}, ${farmer.taluka}, ${farmer.district}`)
      })

      if (totalFarmers > 15) {
        console.log(`   ... and ${totalFarmers - 15} more farmers`)
      }
    }

    // Confirmation prompt
    console.log("\n⚠️  WARNING: This action cannot be undone!")
    console.log(`   ${otherUsersCount} users and ${totalFarmers} farmers will be permanently deleted.`)
    console.log("   Press Ctrl+C to cancel or wait 20 seconds to continue...")
    
    // Wait 20 seconds for user to cancel
    await new Promise(resolve => setTimeout(resolve, 20000))

    // Proceed with deletion
    console.log("\n🗑️  Starting deletion process...")
    
    // Delete users first
    let userDeleteResult = null
    if (otherUsersCount > 0) {
      console.log("   Deleting users...")
      userDeleteResult = await User.deleteMany({ role: { $ne: "SUPER_ADMIN" } })
      console.log(`   ✅ Deleted ${userDeleteResult.deletedCount} users`)
    }

    // Delete farmers
    let farmerDeleteResult = null
    if (totalFarmers > 0) {
      console.log("   Deleting farmers...")
      farmerDeleteResult = await Farmer.deleteMany({})
      console.log(`   ✅ Deleted ${farmerDeleteResult.deletedCount} farmers`)
    }
    
    console.log("✅ Deletion completed!")

    // Verify results
    const remainingUsers = await User.countDocuments()
    const remainingSuperAdmins = await User.countDocuments({ role: "SUPER_ADMIN" })
    const remainingFarmers = await Farmer.countDocuments()
    
    console.log("\n📊 Final Data Statistics:")
    console.log(`   Total Users Remaining: ${remainingUsers}`)
    console.log(`   Super Admins Remaining: ${remainingSuperAdmins}`)
    console.log(`   Other Users Remaining: ${remainingUsers - remainingSuperAdmins}`)
    console.log(`   Total Farmers Remaining: ${remainingFarmers}`)

    if (remainingSuperAdmins > 0) {
      const remainingSuperAdminList = await User.find({ role: "SUPER_ADMIN" })
        .select("name phoneNumber role jobTitle")
      
      console.log("\n👑 Remaining Super Admin(s):")
      remainingSuperAdminList.forEach((admin, index) => {
        console.log(`   ${index + 1}. ${admin.name} (${admin.phoneNumber}) - ${admin.role}${admin.jobTitle ? ` - ${admin.jobTitle}` : ""}`)
      })
    }

    console.log("\n✅ Comprehensive data cleanup process completed successfully!")

  } catch (error) {
    console.error("❌ Error during data cleanup:", error.message)
    throw error
  }
}

// Main execution
const main = async () => {
  try {
    await connectDB()
    await deleteAllDataExceptSuperAdmin()
  } catch (error) {
    console.error("❌ Script failed:", error.message)
    process.exit(1)
  } finally {
    await disconnectDB()
  }
}

// Run the script
main() 