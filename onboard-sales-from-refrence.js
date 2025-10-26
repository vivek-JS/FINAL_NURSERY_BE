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
  
  // Convert to string and remove all non-digit characters
  let cleaned = phoneNumber.toString().replace(/\D/g, '');
  
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

// Function to onboard sales users from Refrence and adjacent Mobile No
const onboardSalesFromRefrence = async () => {
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

    // Get all columns
    const firstRow = data[0];
    const columns = Object.keys(firstRow);
    
    console.log('📋 Available columns:', columns);

    // Find the Refrence column
    const refrenceColumn = columns.find(col => col === 'Refrence');
    
    if (!refrenceColumn) {
      console.error('❌ Refrence column not found in Excel file');
      console.log('Available columns:', columns);
      return;
    }

    // Find the index of Refrence column
    const refrenceIndex = columns.indexOf(refrenceColumn);
    console.log(`✅ Found Refrence column at index ${refrenceIndex}`);

    // Find the Mobile No column that's right beside Refrence
    let mobileColumn = null;
    
    // Check the column right after Refrence
    if (refrenceIndex + 1 < columns.length) {
      const nextColumn = columns[refrenceIndex + 1];
      if (nextColumn === 'Mobile No') {
        mobileColumn = nextColumn;
        console.log(`✅ Found Mobile No column right after Refrence: "${mobileColumn}"`);
      }
    }
    
    // If not found after, check the column right before Refrence
    if (!mobileColumn && refrenceIndex > 0) {
      const prevColumn = columns[refrenceIndex - 1];
      if (prevColumn === 'Mobile No') {
        mobileColumn = prevColumn;
        console.log(`✅ Found Mobile No column right before Refrence: "${mobileColumn}"`);
      }
    }

    if (!mobileColumn) {
      console.error('❌ Mobile No column not found adjacent to Refrence column');
      console.log('Columns around Refrence:');
      if (refrenceIndex > 0) {
        console.log(`   Before: "${columns[refrenceIndex - 1]}"`);
      }
      console.log(`   Refrence: "${columns[refrenceIndex]}"`);
      if (refrenceIndex + 1 < columns.length) {
        console.log(`   After: "${columns[refrenceIndex + 1]}"`);
      }
      return;
    }

    console.log(`📝 Using columns: "${refrenceColumn}" and "${mobileColumn}"`);
    console.log('');

    // Process each row
    let createdCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const name = row[refrenceColumn];
      const mobileNumber = row[mobileColumn];

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
    console.log(`📊 Total rows processed: ${data.length}`);
    
    if (errors.length > 0) {
      console.log('\n❌ Errors encountered:');
      errors.forEach(error => {
        console.log(`   Row ${error.row}: ${error.name} (${error.mobileNumber}) - ${error.error}`);
      });
    }

    if (createdCount > 0) {
      console.log('\n🔑 Default password for all new users: 1234');
      console.log('📱 Users will see password set popup on first login');
      console.log('🎉 Successfully onboarded sales users from Refrence and adjacent Mobile No!');
    }

  } catch (error) {
    console.error('❌ Error processing Excel file:', error);
  } finally {
    mongoose.connection.close();
    console.log('Database connection closed');
  }
};

// Run the script
onboardSalesFromRefrence(); 