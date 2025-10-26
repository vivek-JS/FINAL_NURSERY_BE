import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import User from './models/user.model.js';

dotenv.config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✅ Connected to database');
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    process.exit(1);
  }
};

const createTestSalesUser = async () => {
  try {
    await connectDB();

    console.log('🔍 Creating test sales user for Android app...');

    // Test sales user credentials
    const testUser = {
      name: 'Test Sales User',
      phoneNumber: 9876543210,
      password: '1234',
      role: 'SALES',
      jobTitle: 'SALES',
      isPasswordSet: false,
      isDisabled: false,
      isOnboarded: true
    };

    // Check if user already exists
    const existingUser = await User.findOne({ phoneNumber: testUser.phoneNumber });
    
    if (existingUser) {
      console.log('⚠️  Test sales user already exists:');
      console.log(`   Name: ${existingUser.name}`);
      console.log(`   Phone: ${existingUser.phoneNumber}`);
      console.log(`   Role: ${existingUser.role}`);
      console.log(`   Job Title: ${existingUser.jobTitle}`);
      console.log(`   Password: ${testUser.password}`);
      return;
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(testUser.password, 10);

    // Create new test sales user
    const newUser = new User({
      name: testUser.name,
      phoneNumber: testUser.phoneNumber,
      password: hashedPassword,
      role: testUser.role,
      jobTitle: testUser.jobTitle,
      isPasswordSet: testUser.isPasswordSet,
      isDisabled: testUser.isDisabled,
      isOnboarded: testUser.isOnboarded
    });

    await newUser.save();
    
    console.log('✅ Test sales user created successfully!');
    console.log('📱 Android App Login Credentials:');
    console.log(`   Phone Number: ${testUser.phoneNumber}`);
    console.log(`   Password: ${testUser.password}`);
    console.log(`   Job Title: ${testUser.jobTitle}`);
    console.log('');
    console.log('🔐 You can now use these credentials in the Android app!');

  } catch (error) {
    console.error('❌ Error creating test sales user:', error.message);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from database');
  }
};

// Run the function
createTestSalesUser(); 