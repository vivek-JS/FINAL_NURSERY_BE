import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { importOrdersAndFarmers } from './controllers/excel.serveces.controller.js';

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

const importOrders = async () => {
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
    
    console.log(`\n🚀 Starting import process...`);
    console.log('='.repeat(80));
    
    const results = await importOrdersAndFarmers(fileBuffer, {
      skipExisting: false, // Update existing orders
      autoCreateSalesPersons: true, // Auto-create missing sales persons
    });

    console.log('\n' + '='.repeat(80));
    console.log('📊 IMPORT RESULTS');
    console.log('='.repeat(80));
    
    if (results.summary) {
      console.log(`Total Processed: ${results.summary.totalProcessed || 0}`);
      console.log(`✅ Successful: ${results.summary.successfulImports || 0}`);
      console.log(`❌ Failed: ${results.summary.failedImports || 0}`);
      console.log(`⚠️  Overflow Slots: ${results.summary.overflowSlots || 0}`);
      console.log(`👥 Auto-created Sales Persons: ${results.autoCreatedSalesPersons?.length || 0}`);
      console.log(`🌱 Auto-created Plants/Varieties: ${results.autoCreatedVarieties?.length || 0}`);
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
      const errorFilePath = path.join(__dirname, 'fetch-excel', 'import-errors.txt');
      let errorText = 'IMPORT ERRORS\n';
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

importOrders();

