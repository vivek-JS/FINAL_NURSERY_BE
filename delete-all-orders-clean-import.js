import dotenv from 'dotenv';
dotenv.config();
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

const deleteAllOrdersAndImport = async () => {
  try {
    await connectDB();

    const Order = (await import('./models/order.model.js')).default;
    const ErrorfulOrder = (await import('./models/errorfulOrder.model.js')).default;
    
    console.log('\n🗑️  Step 1: Deleting All Orders...');
    console.log('═══════════════════════════════════════════════\n');
    
    // Count orders before deletion
    const orderCount = await Order.countDocuments();
    console.log(`📊 Found ${orderCount} orders in database`);
    
    if (orderCount > 0) {
      const deleteResult = await Order.deleteMany({});
      console.log(`✅ Deleted ${deleteResult.deletedCount} order(s)\n`);
    } else {
      console.log('ℹ️  No orders found to delete\n');
    }
    
    // Also delete all errorful orders
    const errorfulCount = await ErrorfulOrder.countDocuments();
    if (errorfulCount > 0) {
      const deleteErrorfulResult = await ErrorfulOrder.deleteMany({});
      console.log(`✅ Deleted ${deleteErrorfulResult.deletedCount} errorful order(s)\n`);
    }
    
    console.log('\n📥 Step 2: Reading Excel File and Filtering (Excluding Banana)...');
    console.log('═══════════════════════════════════════════════\n');
    
    const jsonFilePath = path.join(__dirname, 'deployment', 'excel-data-BOOKING LIST-with-name-only.json');
    
    if (!fs.existsSync(jsonFilePath)) {
      console.error('❌ JSON file not found. Please run read-deployment-excel.py first.');
      await mongoose.connection.close();
      return;
    }

    // Read JSON data
    const jsonData = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
    
    if (!jsonData || jsonData.length === 0) {
      console.error('❌ No data found in JSON file');
      await mongoose.connection.close();
      return;
    }

    console.log(`📊 Total rows in Excel: ${jsonData.length}`);
    
    // Filter out Banana rows - keep only Papaya, Watermelon, Muskmelon
    const nonBananaRows = jsonData.filter(row => {
      const crop = row.Crop ? row.Crop.toString().trim().toLowerCase() : '';
      return crop !== 'banana' && (crop === 'papaya' || crop === 'watermelon' || crop === 'muskmelon');
    });
    
    console.log(`📊 Rows after filtering (excluding Banana): ${nonBananaRows.length}`);
    console.log(`   Excluded: ${jsonData.length - nonBananaRows.length} rows (Banana + others)`);
    
    // Count by crop
    const cropCounts = {};
    nonBananaRows.forEach(row => {
      const crop = row.Crop || 'Unknown';
      cropCounts[crop] = (cropCounts[crop] || 0) + 1;
    });
    
    console.log('\n📋 Rows by Crop (to be imported):');
    Object.entries(cropCounts).forEach(([crop, count]) => {
      console.log(`   ${crop}: ${count} rows`);
    });
    
    if (nonBananaRows.length === 0) {
      console.log('\n⚠️  No rows to import');
      await mongoose.connection.close();
      return;
    }
    
    // Convert to Excel format for import
    const excelRows = nonBananaRows.map(row => ({
      'Date': row.Date,
      'Booking NO.': row['Booking NO.'] || 0,
      'Name': row.Name,
      'Mobile No.': row['Mobile No.'],
      'Address': row.Address,
      'Taluka': row.Taluka,
      'District': row.District,
      'Advance\r\nAmt.': row['Advance\nAmt.'] || row['Advance Amt.'],
      'Crop': row.Crop,
      'Variety': row.Variety, // Keep original variety name (no mapping)
      'Media': row.Media,
      'Plant Qty.': row['Plant Qty.'],
      'Rate': row.Rate,
      'Expected\r\nDel.\r\nDate': row['Expected\nDel.\nDate'],
      'Del.\r\nY/N': row['Del.\nY/N'] || row['Del. Y/N'] || 'N',
      'Refrence': row.Refrence || row['Order\nBy'],
      'Ad. Amt. Mode': row['Ad. Amt. Mode'],
      'Bank': row.Bank,
      'CH No.': row['CH No.'],
      'Advance\r\nDate': row['Advance\nDate'],
      'Remark': row.Remark || ''
    }));

    // Create Excel workbook with filtered rows
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(excelRows);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    console.log('\n📥 Step 3: Importing filtered orders (Papaya, Watermelon, Muskmelon)...');
    console.log('   (With status mapping: Y=COMPLETED, TC=PENDING, N=ACCEPTED)');
    console.log('   (With cavity logic: extracts number from "X Cavity" format)');
    console.log('   (NO variety mapping - using exact Excel variety names)\n');
    
    const importResults = await importOrdersAndFarmers(excelBuffer, {
      sourceFilename: 'non-banana-orders-clean.xlsx'
    });

    console.log('\n═══════════════════════════════════════════════');
    console.log('📊 Import Results:');
    console.log('═══════════════════════════════════════════════');
    console.log(`Total Processed: ${importResults.summary.totalProcessed}`);
    console.log(`Successful: ${importResults.summary.successfulImports}`);
    console.log(`Failed: ${importResults.summary.failedImports}`);
    
    if (importResults.summary.overflowSlots > 0) {
      console.log(`Overflow Slots: ${importResults.summary.overflowSlots}`);
    }
    
    if (importResults.summary.invalidPhoneNumbers > 0) {
      console.log(`Invalid Phone Numbers: ${importResults.summary.invalidPhoneNumbers}`);
    }
    
    // Group success by crop
    if (importResults.success.length > 0) {
      console.log('\n✅ Successful Imports Summary:');
      console.log(`   Total: ${importResults.success.length} orders`);
    }
    
    if (importResults.errors.length > 0) {
      console.log('\n❌ Errors Summary:');
      console.log(`   Total: ${importResults.errors.length} errors`);
      
      // Show first 5 errors
      console.log('\n   First 5 Errors:');
      importResults.errors.slice(0, 5).forEach((error, idx) => {
        console.log(`   ${idx + 1}. Booking ${error.bookingNo || 'N/A'}: ${error.error || 'Unknown error'}`);
      });
    }
    
    console.log('\n═══════════════════════════════════════════════');
    if (importResults.summary.successfulImports > 0) {
      console.log(`✅ Successfully imported ${importResults.summary.successfulImports} orders!`);
      console.log(`   (Excluded Banana, imported: Papaya, Watermelon, Muskmelon)`);
      console.log(`   (No variety mapping applied - using exact Excel names)`);
    } else {
      console.log('❌ No orders were imported. Please check errors above.');
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
    process.exit(0);
  }
};

deleteAllOrdersAndImport();





