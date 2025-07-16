import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

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

// Import the actual User model
import User from './models/user.model.js';

// Default password
const DEFAULT_PASSWORD = 'Nursery@2024';

// Function to hash password
const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

// Function to add users
const addUsers = async () => {
  try {
    await connectDB();

    // Check if users already exist
    const existingAccountant = await User.findOne({ phoneNumber: 7588686451 });
    const existingOfficeAdmin = await User.findOne({ phoneNumber: 7588686450 });

    if (existingAccountant) {
      console.log('Accountant Vivek already exists');
      console.log('   Phone: 7588686451');
      console.log('   Role: ACCOUNTANT');
    } else {
      // Add Accountant Vivek
      const accountantPassword = await hashPassword(DEFAULT_PASSWORD);
      const accountant = new User({
        name: 'Vivek',
        phoneNumber: 7588686451, // Changed from 'phone' to 'phoneNumber' and made it Number
        password: accountantPassword,
        role: 'ACCOUNTANT',
        jobTitle: 'ACCOUNTANT',
        isPasswordSet: false, // Will show password set popup on first login
        isDisabled: false,
        isOnboarded: true
      });

      await accountant.save();
      console.log('✅ Accountant Vivek added successfully');
      console.log('   Phone: 7588686451');
      console.log('   Default Password: Nursery@2024');
      console.log('   Role: ACCOUNTANT');
      console.log('   Password Set: false (will show popup on first login)');
    }

    if (existingOfficeAdmin) {
      console.log('Office Admin Sunil already exists');
      console.log('   Phone: 7588686450');
      console.log('   Role: OFFICE_ADMIN');
    } else {
      // Add Office Admin Sunil
      const officeAdminPassword = await hashPassword(DEFAULT_PASSWORD);
      const officeAdmin = new User({
        name: 'Sunil',
        phoneNumber: 7588686450, // Changed from 'phone' to 'phoneNumber' and made it Number
        password: officeAdminPassword,
        role: 'OFFICE_ADMIN',
        jobTitle: 'OFFICE_ADMIN',
        isPasswordSet: false, // Will show password set popup on first login
        isDisabled: false,
        isOnboarded: true
      });

      await officeAdmin.save();
      console.log('✅ Office Admin Sunil added successfully');
      console.log('   Phone: 7588686450');
      console.log('   Default Password: Nursery@2024');
      console.log('   Role: OFFICE_ADMIN');
      console.log('   Password Set: false (will show popup on first login)');
    }

    console.log('\n📋 Summary:');
    console.log('Default password for both users: Nursery@2024');
    console.log('Both users will see password set popup on first login');
    console.log('Accountant can add/change payment status');
    console.log('Office Admin can only add PENDING payments');

  } catch (error) {
    console.error('Error adding users:', error);
  } finally {
    mongoose.connection.close();
    console.log('Database connection closed');
  }
};

// Run the script
addUsers(); 