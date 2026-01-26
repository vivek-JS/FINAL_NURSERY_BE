import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { importOrdersFromExcel } from './controllers/excel.serveces.controller.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

async function testImport() {
  try {
    console.log('🔌 Connecting to database...');
    await connectDB();
    console.log('✅ Connected to database\n');

    const filePath = path.join(__dirname, 'fetch-excel', 'BOOKING DETAILS 2025-26 (8).xlsx');
    
    if (!fs.existsSync(filePath)) {
      console.error('❌ File not found:', filePath);
      process.exit(1);
    }

    console.log('📄 Reading Excel file:', filePath);
    const fileBuffer = fs.readFileSync(filePath);
    
    console.log('🔐 Password: AV1312');
    console.log('📊 Row Limit: 10 (first 10 rows only)\n');
    
    console.log('🚀 Starting import...\n');
    
    const results = await importOrdersFromExcel(fileBuffer, {
      importBatchId: `test-import-${Date.now()}`,
      sourceFilename: 'BOOKING DETAILS 2025-26 (8).xlsx',
      password: 'AV1312',
      rowLimit: 10
    });

    console.log('\n' + '='.repeat(60));
    console.log('📊 IMPORT RESULTS SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Successfully imported: ${results.success} orders`);
    console.log(`❌ Failed: ${results.failed} orders`);
    console.log(`🔄 Skipped: ${results.skipped.length} orders`);
    console.log(`👤 Auto-created Farmers: ${results.autoCreatedFarmers.length}`);
    console.log(`👥 Auto-created Sales Persons: ${results.autoCreatedSalesPersons.length}`);
    console.log(`📦 Auto-created Trays: ${results.autoCreatedTrays?.length || 0}`);
    console.log(`👤 Auto-created Reference Users: ${results.autoCreatedReferenceUsers?.length || 0}`);
    console.log(`📋 Errorful Orders Stored: ${results.errorfulOrders.length}`);

    if (results.autoCreatedFarmers.length > 0) {
      console.log('\n👤 Auto-Created Farmers:');
      results.autoCreatedFarmers.forEach((farmer, i) => {
        console.log(`  ${i + 1}. ${farmer.name} (${farmer.mobileNumber})`);
      });
    }

    if (results.autoCreatedSalesPersons.length > 0) {
      console.log('\n👥 Auto-Created Sales Persons:');
      results.autoCreatedSalesPersons.forEach((person, i) => {
        console.log(`  ${i + 1}. ${person.name} (${person.phoneNumber})`);
      });
    }

    if (results.autoCreatedTrays && results.autoCreatedTrays.length > 0) {
      console.log('\n📦 Auto-Created Trays:');
      results.autoCreatedTrays.forEach((tray, i) => {
        console.log(`  ${i + 1}. ${tray.name} (Cavity: ${tray.cavity})`);
      });
    }

    if (results.autoCreatedReferenceUsers && results.autoCreatedReferenceUsers.length > 0) {
      console.log('\n👤 Auto-Created Reference Users:');
      results.autoCreatedReferenceUsers.forEach((user, i) => {
        console.log(`  ${i + 1}. ${user.name} (${user.phoneNumber})`);
      });
    }

    if (results.skipped.length > 0) {
      console.log('\n🔄 Skipped Orders:');
      results.skipped.forEach((skip, i) => {
        console.log(`  ${i + 1}. Row ${skip.row}: ${skip.reason}`);
      });
    }

    if (results.errors.length > 0) {
      console.log('\n❌ ERRORS:');
      results.errors.forEach((error, i) => {
        console.log(`  ${i + 1}. ${error}`);
      });
    }

    if (results.errorfulOrders.length > 0) {
      console.log('\n📋 ERRORFUL ORDERS (Stored in Database):');
      results.errorfulOrders.forEach((order, i) => {
        console.log(`  ${i + 1}. Row ${order.row} - Booking: ${order.bookingNumber || 'N/A'}`);
        console.log(`     Error Type: ${order.errorType}`);
        console.log(`     Error: ${order.errorMessage}`);
        console.log('');
      });
    }

    console.log('='.repeat(60));
    
    if (results.failed > 0 || results.errorfulOrders.length > 0) {
      console.log('\n⚠️  Some orders failed to import. Check the errors above.');
      console.log('💡 You can retry failed orders using the retry endpoint after fixing issues.');
    } else if (results.success > 0) {
      console.log('\n✅ All orders imported successfully!');
    }

    process.exit(0);
  } catch (error) {
    console.error('\n❌ FATAL ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

testImport();

