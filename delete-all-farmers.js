import mongoose from "mongoose"
import dotenv from "dotenv"
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

// Delete all farmers
const deleteAllFarmers = async () => {
  try {
    console.log("🔍 Starting farmer cleanup process...")
    
    // Get count before deletion
    const totalFarmers = await Farmer.countDocuments()

    console.log("\n📊 Current Farmer Statistics:")
    console.log(`   Total Farmers: ${totalFarmers}`)

    if (totalFarmers === 0) {
      console.log("✅ No farmers to delete.")
      return
    }

    // Show what will be deleted
    console.log("\n🗑️  Farmers that will be deleted:")
    const farmersToDelete = await Farmer.find({})
      .select("name mobileNumber village taluka district state")
      .sort({ name: 1 })
      .limit(20) // Show first 20 for preview

    farmersToDelete.forEach((farmer, index) => {
      console.log(`   ${index + 1}. ${farmer.name} (${farmer.mobileNumber}) - ${farmer.village}, ${farmer.taluka}, ${farmer.district}`)
    })

    if (totalFarmers > 20) {
      console.log(`   ... and ${totalFarmers - 20} more farmers`)
    }

    // Confirmation prompt
    console.log("\n⚠️  WARNING: This action cannot be undone!")
    console.log(`   ${totalFarmers} farmers will be permanently deleted.`)
    console.log("   Press Ctrl+C to cancel or wait 10 seconds to continue...")
    
    // Wait 10 seconds for user to cancel
    await new Promise(resolve => setTimeout(resolve, 10000))

    // Proceed with deletion
    console.log("\n🗑️  Starting deletion process...")
    
    const deleteResult = await Farmer.deleteMany({})
    
    console.log("✅ Deletion completed!")
    console.log(`   Deleted ${deleteResult.deletedCount} farmers`)

    // Verify results
    const remainingFarmers = await Farmer.countDocuments()
    
    console.log("\n📊 Final Farmer Statistics:")
    console.log(`   Total Farmers Remaining: ${remainingFarmers}`)

    console.log("\n✅ Farmer cleanup process completed successfully!")

  } catch (error) {
    console.error("❌ Error during farmer cleanup:", error.message)
    throw error
  }
}

// Main execution
const main = async () => {
  try {
    await connectDB()
    await deleteAllFarmers()
  } catch (error) {
    console.error("❌ Script failed:", error.message)
    process.exit(1)
  } finally {
    await disconnectDB()
  }
}

// Run the script
main() 