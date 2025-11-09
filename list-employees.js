import mongoose from "mongoose"
import dotenv from "dotenv"

import Employee from "./models/employee.model.js"

dotenv.config()

const DEFAULT_URI = "mongodb://127.0.0.1:27017/nursery"

const connectDB = async () => {
  const mongoUri =
    process.env.MONGO_URL ||
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    DEFAULT_URI

  console.log("Connecting to MongoDB...")
  await mongoose.connect(mongoUri)
  console.log("✅ Connected to MongoDB\n")
}

const listEmployees = async () => {
  try {
    await connectDB()

    const employees = await Employee.find().sort({ name: 1 })

    if (employees.length === 0) {
      console.log("❌ No employees found in database")
      return
    }

    console.log("👥 Employees:")
    console.log("=".repeat(80))

    employees.forEach((employee, index) => {
      console.log(`${index + 1}. Name: ${employee.name || "N/A"}`)
      console.log(`   Email: ${employee.email || "N/A"}`)
      console.log(`   Phone: ${employee.phoneNumber || "N/A"}`)
      console.log(`   Job Title: ${employee.jobTitle || "N/A"}`)
      console.log("-".repeat(80))
    })

    console.log(`\n📊 Total Employees: ${employees.length}`)
  } catch (error) {
    console.error("❌ Error listing employees:", error.message)
  } finally {
    await mongoose.connection.close()
    console.log("\n🔌 Disconnected from MongoDB")
  }
}

listEmployees()




