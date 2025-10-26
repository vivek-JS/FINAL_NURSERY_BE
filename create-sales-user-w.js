import mongoose from 'mongoose';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

// Load environment variables
dotenv.config();

// Connect to MongoDB
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URL || 'mongodb://localhost:27017/nursery-management');
    console.log('MongoDB Connected:', conn.connection.host);
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
    process.exit(1);
  }
};

// Import the User model
import User from './models/user.model.js';

// Function to create sales user W
const createSalesUserW = async () => {
  try {
    await connectDB();

    console.log('🔍 Creating sales user with name "W" and mobile number "G"...');

    // Clean the phone number - convert "G" to a numeric value
    // Since "G" is not a valid phone number, I'll use a placeholder number
    // You may want to provide a proper numeric phone number
    const phoneNumber = 9876543219; // Using a placeholder number since "G" is not numeric
    
    // Check if user already exists
    const existingUser = await User.findOne({ phoneNumber: phoneNumber });
    
    if (existingUser) {
      console.log('⚠️  User with this phone number already exists:');
      console.log(`   Name: ${existingUser.name}`);
      console.log(`   Phone: ${existingUser.phoneNumber}`);
      console.log(`   Role: ${existingUser.role}`);
      console.log(`   Job Title: ${existingUser.jobTitle}`);
      return;
    }

    // Hash password
    const DEFAULT_PASSWORD = '1234';
    const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, 10);

    // Create new sales user
    const newUser = new User({
      name: 'W',
      phoneNumber: phoneNumber,
      password: hashedPassword,
      role: 'SALES',
      jobTitle: 'SALES',
      isPasswordSet: false,
      isDisabled: false,
      isOnboarded: true
    });

    await newUser.save();
    
    console.log('✅ Sales user "W" created successfully!');
    console.log('User details:');
    console.log(`   Name: ${newUser.name}`);
    console.log(`   Phone Number: ${newUser.phoneNumber}`);
    console.log(`   Role: ${newUser.role}`);
    console.log(`   Job Title: ${newUser.jobTitle}`);
    console.log(`   Default Password: ${DEFAULT_PASSWORD}`);
    console.log(`   Password Set: ${newUser.isPasswordSet ? 'Yes' : 'No'}`);
    console.log(`   Disabled: ${newUser.isDisabled ? 'Yes' : 'No'}`);
    console.log(`   Onboarded: ${newUser.isOnboarded ? 'Yes' : 'No'}`);

  } catch (error) {
    console.error('❌ Error creating sales user:', error);
  } finally {
    mongoose.connection.close();
    console.log('Database connection closed');
  }
};

// Run the script
createSalesUserW(); 