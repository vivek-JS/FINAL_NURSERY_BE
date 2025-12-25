import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { processExcelRowsForValidation } from './controllers/excel.serveces.controller.js';
import XLSX from 'xlsx';

// Load environment variables
dotenv.config({ path: path.join(process.cwd(), '.env') });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function validateExcelFile() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URL || process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!mongoUri) {
      console.error('❌ MONGO_URL or MONGODB_URI not found in environment variables');
      process.exit(1);
    }

    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    const filePath = path.join(__dirname, 'fetch-excel', 'new_booking.xlsx');
    
    if (!fs.existsSync(filePath)) {
      console.error(`❌ File not found: ${filePath}`);
      await mongoose.disconnect();
      return;
    }

    console.log(`📄 Reading Excel file: ${filePath}`);
    const fileBuffer = fs.readFileSync(filePath);
    
    console.log(`🔍 Processing Excel file for validation...`);
    const results = await processExcelRowsForValidation(fileBuffer);
    
    console.log('\n' + '='.repeat(80));
    console.log('📊 VALIDATION RESULTS');
    console.log('='.repeat(80));
    console.log(`Total Rows: ${results.totalRows}`);
    console.log(`✅ Processable Rows: ${results.processableRows}`);
    console.log(`❌ Rows with Errors: ${results.unprocessedRows.length}`);
    console.log('='.repeat(80));
    
    if (results.errors && results.errors.length > 0) {
      // Group errors by type
      const errorsByType = {};
      results.errors.forEach(error => {
        const type = error.errorType || 'UNKNOWN_ERROR';
        if (!errorsByType[type]) {
          errorsByType[type] = [];
        }
        errorsByType[type].push(error);
      });
      
      console.log('\n📋 ERROR SUMMARY BY TYPE:');
      console.log('-'.repeat(80));
      Object.keys(errorsByType).forEach(type => {
        console.log(`\n${type}: ${errorsByType[type].length} error(s)`);
      });
      
      console.log('\n\n📝 DETAILED ERROR LIST:');
      console.log('='.repeat(80));
      
      results.errors.forEach((error, index) => {
        console.log(`\n${index + 1}. Row ${error.row}`);
        console.log(`   Booking No: ${error.bookingNo || 'N/A'}`);
        console.log(`   Name: ${error.name || 'N/A'}`);
        console.log(`   Crop: ${error.crop || 'N/A'}`);
        console.log(`   Variety: ${error.variety || 'N/A'}`);
        console.log(`   Error Type: ${error.errorType || 'UNKNOWN_ERROR'}`);
        console.log(`   Errors:`);
        error.errors.forEach(err => {
          console.log(`     - ${err}`);
        });
      });
      
      // Create error summary file
      const errorSummaryPath = path.join(__dirname, 'fetch-excel', 'error-list.txt');
      let errorText = '='.repeat(80) + '\n';
      errorText += 'EXCEL VALIDATION ERROR LIST\n';
      errorText += '='.repeat(80) + '\n\n';
      errorText += `Generated: ${new Date().toISOString()}\n`;
      errorText += `Total Rows: ${results.totalRows}\n`;
      errorText += `Processable Rows: ${results.processableRows}\n`;
      errorText += `Rows with Errors: ${results.unprocessedRows.length}\n`;
      errorText += '='.repeat(80) + '\n\n';
      
      errorText += 'ERROR SUMMARY BY TYPE:\n';
      errorText += '-'.repeat(80) + '\n';
      Object.keys(errorsByType).forEach(type => {
        errorText += `${type}: ${errorsByType[type].length} error(s)\n`;
      });
      
      errorText += '\n\nDETAILED ERROR LIST:\n';
      errorText += '='.repeat(80) + '\n\n';
      
      results.errors.forEach((error, index) => {
        errorText += `${index + 1}. Row ${error.row} | ${error.bookingNo || 'N/A'} | ${error.name || 'N/A'} | ${error.crop || 'N/A'} | ${error.variety || 'N/A'} | ${error.errorType || 'UNKNOWN_ERROR'}\n`;
        error.errors.forEach(err => {
          errorText += `   - ${err}\n`;
        });
        errorText += '\n';
      });
      
      fs.writeFileSync(errorSummaryPath, errorText);
      console.log(`\n✅ Error list saved to: ${errorSummaryPath}`);
      
      // Create Excel file with errors
      if (results.unprocessedRows && results.unprocessedRows.length > 0) {
        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.json_to_sheet(results.unprocessedRows);
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Errors');
        
        const excelErrorPath = path.join(__dirname, 'fetch-excel', 'error-rows.xlsx');
        XLSX.writeFile(workbook, excelErrorPath);
        console.log(`✅ Error rows Excel file saved to: ${excelErrorPath}`);
      }
    } else {
      console.log('\n✅ No errors found! All rows are processable.');
    }
    
    console.log('\n' + '='.repeat(80));
    
    // Disconnect from MongoDB
    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB');
    
  } catch (error) {
    console.error('❌ Error validating Excel file:', error);
    console.error(error.stack);
    try {
      await mongoose.disconnect();
    } catch (e) {
      // Ignore disconnect errors
    }
    process.exit(1);
  }
}

// Run validation
validateExcelFile();

