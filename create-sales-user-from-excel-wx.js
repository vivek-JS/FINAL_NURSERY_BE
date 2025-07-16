import mongoose from 'mongoose';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

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

// Function to clean phone number
const cleanPhoneNumber = (phoneNumber) => {
  if (!phoneNumber) return null;
  
  // Convert to string and remove all non-digit characters
  const cleaned = phoneNumber.toString().replace(/\D/g, '');
  
  // Special case: if the number is "860074652", convert it to "8600746452"
  if (cleaned === '860074652') {
    return 8600746452;
  }
  
  // Check if it's a valid Indian phone number (10 digits starting with 6-9)
  if (cleaned.length === 10 && /^[6-9]/.test(cleaned)) {
    return parseInt(cleaned);
  }
  
  // If it's 11 digits and starts with 0, remove the 0
  if (cleaned.length === 11 && cleaned.startsWith('0')) {
    const withoutZero = cleaned.substring(1);
    if (/^[6-9]/.test(withoutZero)) {
      return parseInt(withoutZero);
    }
  }
  
  // If it's 12 digits and starts with 91, remove the 91
  if (cleaned.length === 12 && cleaned.startsWith('91')) {
    const withoutCountryCode = cleaned.substring(2);
    if (/^[6-9]/.test(withoutCountryCode)) {
      return parseInt(withoutCountryCode);
    }
  }
  
  return null;
};

// Function to hash password
const hashPassword = async (password) => {
  return await bcrypt.hash(password, 10);
};

// Function to create sales user from Excel columns W and X
const createSalesUserFromExcelWX = async () => {
  try {
    await connectDB();

    // Path to the Excel file
    const excelFilePath = path.join(process.cwd(), 'deployment', 'Booking Sep To Feb.xlsx');
    
    // Check if file exists
    if (!fs.existsSync(excelFilePath)) {
      console.error('❌ Excel file not found at:', excelFilePath);
      console.log('Please make sure the file "Booking Sep To Feb.xlsx" is in the deployment folder');
      return;
    }

    console.log('📖 Reading Excel file:', excelFilePath);

    // Read the Excel file
    const workbook = XLSX.readFile(excelFilePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    console.log(`📊 Found ${data.length} rows in the Excel file`);

    // Get the first row to see all columns
    const firstRow = data[0];
    const columns = Object.keys(firstRow);
    
    console.log('📋 Available columns:', columns);

    // Find columns W and X (they might be named differently)
    // Column W is typically the 23rd column (0-indexed: 22)
    // Column X is typically the 24th column (0-indexed: 23)
    
    let columnW = null;
    let columnX = null;
    
    // Try to find columns by position or common names
    if (columns.length >= 24) {
      columnW = columns[22]; // Column W (23rd column, 0-indexed: 22)
      columnX = columns[23]; // Column X (24th column, 0-indexed: 23)
      console.log(`✅ Found columns W and X: "${columnW}" and "${columnX}"`);
    } else {
      console.error('❌ Excel file does not have enough columns (need at least 24 columns for W and X)');
      console.log('Available columns:', columns);
      return;
    }

    // Process each row
    let createdCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const name = row[columnW];
      const mobileNumber = row[columnX];

      // Skip if no name or mobile number
      if (!name || !mobileNumber) {
        skippedCount++;
        continue;
      }

      // Clean the phone number
      const cleanedPhoneNumber = cleanPhoneNumber(mobileNumber);
      
      if (!cleanedPhoneNumber) {
        errors.push({
          row: i + 2,
          name,
          mobileNumber,
          error: 'Invalid phone number format'
        });
        errorCount++;
        continue;
      }

      try {
        // Check if user already exists
        const existingUser = await User.findOne({ phoneNumber: cleanedPhoneNumber });
        
        if (existingUser) {
          console.log(`⏭️  User already exists: ${name} (${cleanedPhoneNumber})`);
          skippedCount++;
          continue;
        }

        // Create new user
        const DEFAULT_PASSWORD = '12345678';
        const hashedPassword = await hashPassword(DEFAULT_PASSWORD);
        const newUser = new User({
          name: name,
          phoneNumber: cleanedPhoneNumber,
          password: hashedPassword,
          role: 'SALES',
          jobTitle: 'SALES',
          isPasswordSet: false,
          isDisabled: false,
          isOnboarded: true
        });

        await newUser.save();
        console.log(`✅ Created sales user: ${name} (${cleanedPhoneNumber})`);
        createdCount++;

      } catch (error) {
        errors.push({
          row: i + 2,
          name,
          mobileNumber: cleanedPhoneNumber,
          error: error.message
        });
        errorCount++;
        console.error(`❌ Error creating user ${name}:`, error.message);
      }
    }

    // Print summary
    console.log('\n📋 Summary:');
    console.log(`✅ Sales users created: ${createdCount}`);
    console.log(`⏭️  Users skipped (already exist): ${skippedCount}`);
    console.log(`❌ Errors: ${errorCount}`);

    if (errors.length > 0) {
      console.log('\n❌ Errors encountered:');
      errors.forEach(error => {
        console.log(`   Row ${error.row}: ${error.name} (${error.mobileNumber}) - ${error.error}`);
      });
    }

    if (createdCount > 0) {
      console.log('\n🎉 Successfully created sales users from Excel columns W and X!');
    }

  } catch (error) {
    console.error('❌ Error creating sales users from Excel:', error);
  } finally {
    mongoose.connection.close();
    console.log('Database connection closed');
  }
};

// Run the script
createSalesUserFromExcelWX(); 