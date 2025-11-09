import dotenv from "dotenv"
import mongoose from "mongoose"
import bcrypt from "bcryptjs"

import User from "./models/user.model.js"

dotenv.config()

const DEFAULT_DB_URI = "mongodb://127.0.0.1:27017/nursery"

const args = process.argv.slice(2)

const usage = `
Usage: node reset-user-password.js <phoneNumber> <newPassword>

Example:
  node reset-user-password.js 9999999703 1234
`

if (args.length < 2) {
  console.log("❌ Missing arguments.")
  console.log(usage)
  process.exit(1)
}

const [phoneArg, newPassword] = args
const phoneNumber = Number(phoneArg)

if (!Number.isInteger(phoneNumber)) {
  console.log("❌ Phone number must be numeric.")
  console.log(usage)
  process.exit(1)
}

if (!newPassword || newPassword.length < 4) {
  console.log("❌ Password must be at least 4 characters long.")
  process.exit(1)
}

const MONGODB_URI = process.env.MONGO_URL || process.env.MONGODB_URI || DEFAULT_DB_URI

const resetPassword = async () => {
  console.log("===========================================")
  console.log(`Reset Password for User: ${phoneNumber}`)
  console.log("===========================================\n")

  try {
    console.log("Connecting to MongoDB...")
    await mongoose.connect(MONGODB_URI)
    console.log("✓ Connected to MongoDB successfully\n")

    console.log(`Finding user with phone number: ${phoneNumber}...`)
    const user = await User.findOne({ phoneNumber })

    if (!user) {
      console.log(`❌ User with phone number ${phoneNumber} not found`)
      return
    }

    console.log("✓ User found:")
    console.log(`   Name: ${user.name}`)
    console.log(`   Phone: ${user.phoneNumber}`)
    console.log(`   Role: ${user.role || "N/A"}`)
    console.log(`   Job Title: ${user.jobTitle || "N/A"}`)
    console.log(`   Disabled: ${user.isDisabled ? "Yes" : "No"}\n`)

    console.log("Hashing new password...")
    const salt = await bcrypt.genSalt(10)
    const hashedPassword = await bcrypt.hash(newPassword, salt)
    console.log("✓ Password hashed successfully\n")

    console.log("Updating password...")
    await User.findByIdAndUpdate(
      user._id,
      {
        password: hashedPassword,
        isPasswordSet: false
      },
      { new: true }
    )
    console.log("✓ Password updated successfully\n")

    console.log("===========================================")
    console.log("✓ SUCCESS!")
    console.log("===========================================")
    console.log(`Password for ${user.name} (${phoneNumber}) has been reset.`)
    console.log(`Temporary PIN: ${newPassword}`)
    console.log("User will be asked to set a new password on next login.")
    console.log("===========================================\n")
  } catch (error) {
    console.error("❌ Error resetting password:", error.message)
  } finally {
    await mongoose.connection.close()
    console.log("🔌 MongoDB connection closed")
  }
}

resetPassword()




