import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
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

// Default password for new users
const DEFAULT_PASSWORD = '1234';

// Function to hash password
const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

// Function to clean phone number
const cleanPhoneNumber = (phoneNumber) => {
  if (!phoneNumber) return null;
  
  // Handle case where phoneNumber is already an array
  if (Array.isArray(phoneNumber)) {
    // Join array elements and try to extract valid numbers
    const joined = phoneNumber.join('');
    phoneNumber = joined;
  }
  
  // Convert to string and remove all non-digit characters (including dashes)
  let cleaned = phoneNumber.toString().replace(/\D/g, '');
  
  // Handle special cases for partial numbers from arrays
  if (cleaned.length < 10 && cleaned.length > 0) {
    // If it's a partial number like "88308" or "33233", skip it
    return null;
  }
  
  // Special case: handle "860074652" -> "8600746452"
  if (cleaned === '860074652') {
    cleaned = '8600746452';
  }
  
  // If it starts with 91 and is 12 digits, remove the 91
  if (cleaned.startsWith('91') && cleaned.length === 12) {
    cleaned = cleaned.substring(2);
  }
  
  // If it's 10 digits, convert to number
  if (cleaned.length === 10) {
    return parseInt(cleaned);
  }
  
  return null;
};

// Function to create sales users from Excel
const createSalesUsersFromExcel = async () => {
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

    // Find the Reference and Mobile No columns
    const firstRow = data[0];
    const columns = Object.keys(firstRow);
    
    console.log('📋 Available columns:', columns);

    // Look for specific columns: "Refrence" and "Mobile No"
    const referenceColumn = columns.find(col => 
      col === 'Refrence' || col === 'Reference'
    );
    
    const mobileColumn = columns.find(col => 
      col === 'Mobile No' || col === 'Mobile No.'
    );

    if (!referenceColumn) {
      console.error('❌ Reference column not found in Excel file');
      console.log('Available columns:', columns);
      return;
    }

    if (!mobileColumn) {
      console.error('❌ Mobile No column not found in Excel file');
      console.log('Available columns:', columns);
      return;
    }

    console.log(`✅ Found columns: "${referenceColumn}" and "${mobileColumn}"`);
    console.log('📝 Will use only these two columns for user creation');
    console.log('');

    // Process each row
    let createdCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const reference = row[referenceColumn];
      const mobileNumber = row[mobileColumn];

      // Skip if no reference or mobile number
      if (!reference || !mobileNumber) {
        skippedCount++;
        continue;
      }

      // Clean the phone number
      const cleanedPhoneNumber = cleanPhoneNumber(mobileNumber);
      
      if (!cleanedPhoneNumber) {
        errors.push({
          row: i + 2,
          reference,
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
          console.log(`⏭️  User already exists: ${reference} (${cleanedPhoneNumber})`);
          skippedCount++;
          continue;
        }

        // Create new user
        const hashedPassword = await hashPassword(DEFAULT_PASSWORD);
        const newUser = new User({
          name: reference,
          phoneNumber: cleanedPhoneNumber,
          password: hashedPassword,
          role: 'SALES',
          jobTitle: 'SALES',
          isPasswordSet: false,
          isDisabled: false,
          isOnboarded: true
        });

        await newUser.save();
        console.log(`✅ Created user: ${reference} (${cleanedPhoneNumber})`);
        createdCount++;

      } catch (error) {
        errors.push({
          row: i + 2,
          reference,
          mobileNumber: cleanedPhoneNumber,
          error: error.message
        });
        errorCount++;
        console.error(`❌ Error creating user ${reference}:`, error.message);
      }
    }

    // Print summary
    console.log('\n📋 Summary:');
    console.log(`✅ Users created: ${createdCount}`);
    console.log(`⏭️  Users skipped (already exist): ${skippedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`📊 Total rows processed: ${data.length}`);
    
    if (errors.length > 0) {
      console.log('\n❌ Errors encountered:');
      errors.forEach(error => {
        console.log(`   Row ${error.row}: ${error.reference} (${error.mobileNumber}) - ${error.error}`);
      });
    }

    console.log('\n🔑 Default password for all new users: 12345678');
    console.log('📱 Users will see password set popup on first login');

  } catch (error) {
    console.error('❌ Error processing Excel file:', error);
  } finally {
    mongoose.connection.close();
    console.log('Database connection closed');
  }
};

// Run the script
createSalesUsersFromExcel(); 