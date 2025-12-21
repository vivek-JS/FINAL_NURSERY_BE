import XLSX from 'xlsx';
import fs from 'fs';
import { importOrdersFromExcel } from './controllers/excel.serveces.controller.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Connect to database
const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI || process.env.DATABASE_URL;
    if (!uri) {
      throw new Error("MONGO_URL or MONGODB_URI environment variable is required.");
    }
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Create Excel file with the order data from image
const createTestExcel = () => {
  // Based on the image data provided
  const orderData = [
    {
      'Date': '1/25/25',
      'Booking NO.': 0, // Will be auto-generated
      'Name': 'Sushila Suresh Atre',
      'Mobile No.': '9404558601',
      'Address': 'Fuknagari',
      'Taluka': 'Jalgaon',
      'District': 'Jalgaon',
      'Advance On': '5/16/25',
      'adv match': 'FALSE',
      'Advance Amt.': 10000,
      'Crop': 'Banana',
      'Variety': 'G-9',
      'Media': '8 Cavity',
      'Expected': 'RB',
      'Plant Qty.': 19,
      'Rate': 8500,
      'Expected Del.': '11/28/25',
      'Old Del. Date': '25-03-2025',
      'Del. Y/N': 'N',
      'Invoice amount': 161500,
      'Bal. Amt.': 161500,
      'Refrence': 'Barde Sir',
      'Order By': 'Barde Sir',
      'Ad. Amt. Mode': 'online',
      'Bank': '',
      'CH No.': '1341',
      'Advance Date': '5/16/25',
      'Receipt Code': 0,
      'ADV Y/N': 'Y',
      'CC Y/N': '',
      'Remark': 'Mukesh Suresh Atre Cahnge Name Add Quantity Ref Sandip P\nON Call 24/7/25\nlu 31/10\nLu 17/11'
    }
  ];

  // Create workbook
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(orderData);
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Orders');

  // Write to file
  const filename = 'test-order-import.xlsx';
  XLSX.writeFile(workbook, filename);
  console.log(`✅ Created test Excel file: ${filename}`);
  
  return filename;
};

// Main function
const main = async () => {
  try {
    await connectDB();
    
    // Create test Excel file
    const filename = createTestExcel();
    const fileBuffer = fs.readFileSync(filename);
    
    console.log('\n🚀 Starting order import...\n');
    
    // Import the order
    const results = await importOrdersFromExcel(fileBuffer, {
      importBatchId: `test-import-${Date.now()}`,
      sourceFilename: filename,
      password: null, // No password for this test
    });
    
    console.log('\n📊 Import Results:');
    console.log(`   ✅ Success: ${results.success}`);
    console.log(`   ❌ Failed: ${results.failed}`);
    console.log(`   🔄 Skipped: ${results.skipped.length}`);
    
    if (results.errors.length > 0) {
      console.log('\n❌ Errors:');
      results.errors.forEach(error => console.log(`   - ${error}`));
    }
    
    if (results.autoCreatedFarmers.length > 0) {
      console.log('\n👤 Auto-created Farmers:');
      results.autoCreatedFarmers.forEach(farmer => {
        console.log(`   - ${farmer.name} (${farmer.mobileNumber || 'No mobile'})`);
      });
    }
    
    if (results.autoCreatedSalesPersons.length > 0) {
      console.log('\n👥 Auto-created Sales Persons:');
      results.autoCreatedSalesPersons.forEach(sp => {
        console.log(`   - ${sp.name} (${sp.phoneNumber || 'No phone'})`);
      });
    }
    
    if (results.autoCreatedTrays && results.autoCreatedTrays.length > 0) {
      console.log('\n📦 Auto-created Trays:');
      results.autoCreatedTrays.forEach(tray => {
        console.log(`   - ${tray.name} (${tray.cavity} cavity)`);
      });
    }
    
    // Clean up test file
    if (fs.existsSync(filename)) {
      fs.unlinkSync(filename);
      console.log(`\n🧹 Cleaned up test file: ${filename}`);
    }
    
    console.log('\n✅ Import test completed!');
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ Import failed:', error);
    process.exit(1);
  }
};

main();

