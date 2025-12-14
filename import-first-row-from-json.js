import dotenv from 'dotenv';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import { importOrdersAndFarmers } from './controllers/excel.serveces.controller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error("MONGO_URL or MONGODB_URI environment variable is required.");
    }
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
};

const importFirstRow = async () => {
  try {
    await connectDB();

    console.log('📥 Importing First Row...');
    console.log('═══════════════════════════════════════════════\n');

    const jsonFilePath = path.join(__dirname, 'deployment', 'excel-data-BOOKING LIST-with-name-only.json');
    
    if (!fs.existsSync(jsonFilePath)) {
      console.error('❌ JSON file not found. Please run read-deployment-excel.py first.');
      return;
    }

    // Read JSON data
    const jsonData = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
    
    if (!jsonData || jsonData.length === 0) {
      console.error('❌ No data found in JSON file');
      return;
    }

    // Get first row
    const firstRow = jsonData[0];
    console.log('📋 First Row Data:');
    console.log('─────────────────────────────────────────────');
    console.log(`Name: ${firstRow.Name}`);
    console.log(`Mobile: ${firstRow['Mobile No.']}`);
    console.log(`Crop: ${firstRow.Crop}`);
    console.log(`Variety: ${firstRow.Variety}`);
    console.log(`Media: ${firstRow.Media}`);
    console.log(`Plant Qty: ${firstRow['Plant Qty.']}`);
    console.log(`Rate: ${firstRow.Rate}`);
    console.log(`Del. Y/N: ${firstRow['Del.\nY/N'] || firstRow['Del. Y/N'] || 'N/A'}`);
    console.log(`Expected Del. Date: ${firstRow['Expected\nDel.\nDate']}`);
    console.log();

    // Convert to Excel format for import
    // Map JSON keys to Excel column names (handling line breaks)
    const excelRow = {
      'Date': firstRow.Date,
      'Booking NO.': firstRow['Booking NO.'] || 0,
      'Name': firstRow.Name,
      'Mobile No.': firstRow['Mobile No.'],
      'Address': firstRow.Address,
      'Taluka': firstRow.Taluka,
      'District': firstRow.District,
      'Advance\r\nAmt.': firstRow['Advance\nAmt.'] || firstRow['Advance Amt.'],
      'Crop': firstRow.Crop,
      'Variety': firstRow.Variety,
      'Media': firstRow.Media,
      'Plant Qty.': firstRow['Plant Qty.'],
      'Rate': firstRow.Rate,
      'Expected\r\nDel.\r\nDate': firstRow['Expected\nDel.\nDate'],
      'Del.\r\nY/N': firstRow['Del.\nY/N'] || firstRow['Del. Y/N'] || 'N',
      'Refrence': firstRow.Refrence || firstRow['Order\nBy'],
      'Ad. Amt. Mode': firstRow['Ad. Amt. Mode'],
      'Bank': firstRow.Bank,
      'CH No.': firstRow['CH No.'],
      'Advance\r\nDate': firstRow['Advance\nDate'],
      'Remark': firstRow.Remark || ''
    };

    // Create Excel workbook with header and first row
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet([excelRow]);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    console.log('📥 Importing first row using updated import logic...');
    console.log('   (With status mapping: Y=COMPLETED, TC=PENDING, N=ACCEPTED)');
    console.log('   (With cavity logic: extracts number from "X Cavity" format)\n');
    
    const importResults = await importOrdersAndFarmers(excelBuffer, {
      sourceFilename: 'first-row-only.xlsx'
    });

    console.log('\n═══════════════════════════════════════════════');
    console.log('📊 Import Results:');
    console.log('─────────────────────────────────────────────');
    console.log(`Total Processed: ${importResults.summary.totalProcessed}`);
    console.log(`Successful: ${importResults.summary.successfulImports}`);
    console.log(`Failed: ${importResults.summary.failedImports}`);
    
    if (importResults.summary.overflowSlots > 0) {
      console.log(`Overflow Slots: ${importResults.summary.overflowSlots}`);
    }
    
    if (importResults.success.length > 0) {
      console.log('\n✅ Successful Import(s):');
      importResults.success.forEach((success, idx) => {
        console.log(`\n   Import ${idx + 1}:`);
        console.log(`   ───────────────────────────────────────────`);
        console.log(`   Farmer: ${success.farmerName || 'N/A'}`);
        console.log(`   Booking No: ${success.bookingNo || 'N/A'}`);
        console.log(`   Order ID: ${success.orderId || 'N/A'}`);
        console.log(`   Amount: ₹${success.amount || 0}`);
        console.log(`   Advance Paid: ₹${success.advancePaid || 0}`);
        console.log(`   Balance: ₹${success.balance || 0}`);
        console.log(`   Phone Status: ${success.phoneStatus || 'N/A'}`);
        if (success.overflowWarning) {
          console.log(`   ⚠️  Warning: ${success.overflowWarning}`);
        }
      });
    }
    
    if (importResults.errors.length > 0) {
      console.log('\n❌ Errors:');
      importResults.errors.forEach((error, idx) => {
        console.log(`\n   Error ${idx + 1}:`);
        console.log(`   ───────────────────────────────────────────`);
        console.log(`   Row: ${error.row || 'N/A'}`);
        console.log(`   Booking No: ${error.bookingNo || 'N/A'}`);
        console.log(`   Error: ${error.error || 'Unknown error'}`);
        if (error.reference) {
          console.log(`   Reference: ${error.reference}`);
        }
        if (error.errorType) {
          console.log(`   Error Type: ${error.errorType}`);
        }
      });
    }
    
    console.log('\n═══════════════════════════════════════════════');
    if (importResults.summary.successfulImports > 0) {
      console.log('✅ First row imported successfully!');
      console.log('\n💡 You can now verify the import by running:');
      console.log('   node check-order-import-detailed.js');
    } else {
      console.log('❌ Import failed. Please check errors above.');
    }
    
  } catch (error) {
    console.error('❌ Error importing first row:', error);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
  }
};

importFirstRow();





