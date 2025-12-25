import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import XLSX from 'xlsx';
import { importOrdersAndFarmers } from './controllers/excel.serveces.controller.js';
import Order from './models/order.model.js';
import Farmer from './models/farmer.model.js';
import ErrorfulOrder from './models/errorfulOrder.model.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGO_URL or MONGODB_URI environment variable is required.');
    }
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
};

// Skip clearing orders - we want to keep existing orders
const clearAllOrders = async () => {
  try {
    console.log('\nℹ️  Skipping order clearing - keeping existing orders...');
    const orderCount = await Order.countDocuments();
    console.log(`   Current orders in database: ${orderCount}`);
    console.log('✅ Ready to import next batch!\n');
  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  }
};

const importFirst100Rows = async () => {
  try {
    await connectDB();

    const filePath = path.join(__dirname, 'fetch-excel', 'new_booking.xlsx');
    
    if (!fs.existsSync(filePath)) {
      console.error(`❌ File not found: ${filePath}`);
      await mongoose.disconnect();
      return;
    }

    console.log(`📄 Reading Excel file: ${filePath}`);
    const fileBuffer = fs.readFileSync(filePath);
    
    // Read Excel and get rows 101-200
    const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: false });
    const worksheet = workbook.Sheets['BOOKING LIST'];
    const allData = XLSX.utils.sheet_to_json(worksheet, { defval: null, raw: true });
    
    console.log(`📊 Total rows in Excel: ${allData.length}`);
    console.log(`📋 Importing rows 801-900\n`);
    
    // Take rows 801-900 (indices 800-899)
    const limitedData = allData.slice(800, 900);
    
    // Create a new workbook with only first 100 rows
    const newWorkbook = XLSX.utils.book_new();
    const newWorksheet = XLSX.utils.json_to_sheet(limitedData);
    XLSX.utils.book_append_sheet(newWorkbook, newWorksheet, 'BOOKING LIST');
    
    // Convert to buffer
    const limitedBuffer = XLSX.write(newWorkbook, { type: 'buffer', bookType: 'xlsx' });
    
    console.log(`🚀 Starting import of rows 801-900...`);
    console.log('='.repeat(80));
    
    const results = await importOrdersAndFarmers(limitedBuffer, {
      skipExisting: false,
      autoCreateSalesPersons: true,
    });

    console.log('\n' + '='.repeat(80));
    console.log('📊 IMPORT RESULTS');
    console.log('='.repeat(80));
    
    if (results.summary) {
      console.log(`Total Processed: ${results.summary.totalProcessed || 0}`);
      console.log(`✅ Successful: ${results.summary.successfulImports || 0}`);
      console.log(`❌ Failed: ${results.summary.failedImports || 0}`);
      console.log(`⚠️  Overflow Slots: ${results.summary.overflowSlots || 0}`);
      
      if (results.autoCreatedSalesPersons && results.autoCreatedSalesPersons.length > 0) {
        console.log(`\n👥 Auto-created Sales Persons: ${results.autoCreatedSalesPersons.length}`);
        results.autoCreatedSalesPersons.slice(0, 5).forEach(sp => {
          console.log(`   - ${sp.name}`);
        });
        if (results.autoCreatedSalesPersons.length > 5) {
          console.log(`   ... and ${results.autoCreatedSalesPersons.length - 5} more`);
        }
      }
      
      if (results.autoCreatedVarieties && results.autoCreatedVarieties.length > 0) {
        console.log(`\n🌱 Auto-created Plants/Varieties: ${results.autoCreatedVarieties.length}`);
        results.autoCreatedVarieties.slice(0, 5).forEach(v => {
          console.log(`   - ${v.plantName} - ${v.varietyName}`);
        });
        if (results.autoCreatedVarieties.length > 5) {
          console.log(`   ... and ${results.autoCreatedVarieties.length - 5} more`);
        }
      }
    }

    if (results.success && results.success.length > 0) {
      console.log(`\n✅ Successful Imports (first 10):`);
      results.success.slice(0, 10).forEach((item, idx) => {
        console.log(`   ${idx + 1}. ${item.bookingNo || 'N/A'} - ${item.farmerName || 'Updated'}`);
      });
      if (results.success.length > 10) {
        console.log(`   ... and ${results.success.length - 10} more`);
      }
    }

    if (results.errors && results.errors.length > 0) {
      console.log(`\n❌ Failed Imports (first 10):`);
      results.errors.slice(0, 10).forEach((error, idx) => {
        console.log(`   ${idx + 1}. ${error.bookingNo || 'N/A'}: ${error.error}`);
      });
      if (results.errors.length > 10) {
        console.log(`   ... and ${results.errors.length - 10} more errors`);
      }
      
      // Save errors to file
      const errorFilePath = path.join(__dirname, 'fetch-excel', 'import-errors-rows-801-900.txt');
      let errorText = 'IMPORT ERRORS (Rows 801-900)\n';
      errorText += '='.repeat(80) + '\n\n';
      errorText += `Total Errors: ${results.errors.length}\n\n`;
      results.errors.forEach((error, idx) => {
        errorText += `${idx + 1}. ${error.bookingNo || 'N/A'}: ${error.error}\n`;
      });
      fs.writeFileSync(errorFilePath, errorText);
      console.log(`\n📄 Full error list saved to: ${errorFilePath}`);
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ Import process completed!');
    console.log('='.repeat(80) + '\n');

    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB');

  } catch (error) {
    console.error('❌ Error during import:', error);
    console.error(error.stack);
    await mongoose.disconnect();
    process.exit(1);
  }
};

// Main execution
(async () => {
  try {
    await connectDB();
    await clearAllOrders();
    await mongoose.disconnect();
    
    // Now import
    await importFirst100Rows();
  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
})();

