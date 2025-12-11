import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { importOrdersAndFarmers } from './controllers/excel.serveces.controller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const importWatermelonExcel = async () => {
  try {
    await connectDB();
    
    const filePath = path.join(__dirname, 'utility', 'watermelon Booking.xlsx');
    
    if (!fs.existsSync(filePath)) {
      console.error(`❌ File not found: ${filePath}`);
      process.exit(1);
    }
    
    console.log('\n📄 Reading Excel file...');
    const fileBuffer = fs.readFileSync(filePath);
    console.log(`✅ File read successfully (${(fileBuffer.length / 1024).toFixed(2)} KB)\n`);
    
    console.log('🚀 Starting import...\n');
    const importBatchId = `import-${Date.now()}`;
    const results = await importOrdersAndFarmers(fileBuffer, {
      importBatchId: importBatchId,
      sourceFilename: 'watermelon Booking.xlsx',
    });
    
    console.log('\n📊 Import Results:');
    console.log('═══════════════════════════════════════');
    console.log(`Total Processed: ${results.summary.totalProcessed}`);
    console.log(`✅ Successful: ${results.summary.successfulImports}`);
    console.log(`❌ Failed: ${results.summary.failedImports}`);
    console.log(`⚠️  Overflow Slots: ${results.summary.overflowSlots}`);
    console.log(`📱 Invalid Phone Numbers: ${results.summary.invalidPhoneNumbers}`);
    
    if (results.autoCreatedSalesPersons && results.autoCreatedSalesPersons.length > 0) {
      console.log(`\n👤 Auto-created Sales Persons: ${results.autoCreatedSalesPersons.length}`);
      results.autoCreatedSalesPersons.forEach(sp => {
        console.log(`   - ${sp.name} (${sp.phoneNumber || 'no phone'})`);
      });
    }
    
    if (results.generatedOrderIds && results.generatedOrderIds.length > 0) {
      console.log(`\n🆔 Generated Order IDs (for booking number 0): ${results.generatedOrderIds.length}`);
      results.generatedOrderIds.slice(0, 5).forEach(item => {
        console.log(`   - Row ${item.row}: ${item.bookingNo} → ${item.generatedOrderId} (${item.name})`);
      });
    }
    
    if (results.errors && results.errors.length > 0) {
      console.log(`\n❌ Errors (${results.errors.length}):`);
      results.errors.slice(0, 10).forEach((error, i) => {
        console.log(`   ${i + 1}. Booking ${error.bookingNo || error.orderId || 'Unknown'}: ${error.error}`);
      });
      if (results.errors.length > 10) {
        console.log(`   ... and ${results.errors.length - 10} more errors`);
      }
    }
    
    if (results.success && results.success.length > 0) {
      console.log(`\n✅ Successful Imports (${results.success.length}):`);
      results.success.slice(0, 5).forEach((success, i) => {
        console.log(`   ${i + 1}. Booking ${success.bookingNo}: ${success.farmerName || 'N/A'} - ${success.orderId || 'N/A'} (${success.numberOfPlants || 'N/A'} plants)`);
      });
      if (results.success.length > 5) {
        console.log(`   ... and ${results.success.length - 5} more successful imports`);
      }
    }
    
    console.log('\n═══════════════════════════════════════');
    console.log(`\n✅ Import completed!`);
    console.log(`   Success Rate: ${((results.summary.successfulImports / results.summary.totalProcessed) * 100).toFixed(1)}%`);
    
  } catch (error) {
    console.error('\n❌ Import Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
};

importWatermelonExcel();

