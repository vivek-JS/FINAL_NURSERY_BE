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

const importFirstOrder = async () => {
  try {
    await connectDB();
    
    const filePath = path.join(__dirname, 'utility', 'watermelon Booking.xlsx');
    
    if (!fs.existsSync(filePath)) {
      console.error(`❌ File not found: ${filePath}`);
      process.exit(1);
    }
    
    console.log('\n📄 Reading Excel file...');
    const workbook = XLSX.readFile(filePath, { cellDates: false, raw: true });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { raw: true, dateNF: 'DD-MM-YYYY', defval: '' });
    
    console.log(`Total rows in Excel: ${data.length}`);
    
    if (data.length === 0) {
      console.error('❌ No data found in Excel file');
      process.exit(1);
    }
    
    // Get first row
    const firstRow = data[0];
    console.log('\n📋 First Row Data:');
    console.log('Booking NO.:', firstRow['Booking NO.']);
    console.log('Name:', firstRow['Name']);
    console.log('Expected Del. Date (raw):', firstRow['Expected\r\nDel.\r\nDate']);
    console.log('Expected Del. Date (type):', typeof firstRow['Expected\r\nDel.\r\nDate']);
    console.log('Del. Y/N:', firstRow['Del. Y/N']);
    console.log('Date:', firstRow['Date']);
    
    // Create a new workbook with just the first row
    const newWorkbook = XLSX.utils.book_new();
    const headerRow = Object.keys(firstRow);
    const newData = [firstRow];
    const newWorksheet = XLSX.utils.json_to_sheet(newData);
    XLSX.utils.book_append_sheet(newWorkbook, newWorksheet, 'Sheet1');
    
    // Convert to buffer
    const buffer = XLSX.write(newWorkbook, { type: 'buffer', bookType: 'xlsx' });
    
    console.log('\n🚀 Importing first order only...\n');
    const importBatchId = `import-${Date.now()}`;
    const results = await importOrdersAndFarmers(buffer, {
      importBatchId: importBatchId,
      sourceFilename: 'watermelon Booking.xlsx',
    });
    
    console.log('\n📊 Import Results:');
    console.log('═══════════════════════════════════════');
    console.log(`Total Processed: ${results.summary.totalProcessed}`);
    console.log(`✅ Successful: ${results.summary.successfulImports}`);
    console.log(`❌ Failed: ${results.summary.failedImports}`);
    
    if (results.success && results.success.length > 0) {
      console.log('\n✅ Successful Import:');
      results.success.forEach((success, i) => {
        console.log(`  ${i + 1}. Booking ${success.bookingNo}: ${success.farmerName || 'N/A'} - ${success.orderId || 'N/A'}`);
      });
    }
    
    if (results.errors && results.errors.length > 0) {
      console.log('\n❌ Errors:');
      results.errors.forEach((error, i) => {
        console.log(`  ${i + 1}. Booking ${error.bookingNo || error.orderId || 'Unknown'}: ${error.error}`);
      });
    }
    
    // Check the imported order
    const Order = (await import('./models/order.model.js')).default;
    const importedOrder = await Order.findOne({}).sort({ createdAt: -1 }).lean();
    
    if (importedOrder) {
      const moment = (await import('moment')).default;
      const deliveryDate = moment.utc(importedOrder.deliveryDate);
      console.log('\n📅 Imported Order Details:');
      console.log(`  Order ID: ${importedOrder.orderId}`);
      console.log(`  Status: ${importedOrder.orderStatus}`);
      console.log(`  Delivery Date: ${deliveryDate.format('YYYY-MM-DD')} (Day: ${deliveryDate.date()}, Month: ${deliveryDate.month() + 1})`);
      console.log(`  ISO String: ${importedOrder.deliveryDate.toISOString()}`);
      
      // Check what the Excel date should be
      const excelDate = firstRow['Expected\r\nDel.\r\nDate'];
      console.log(`\n  Excel Date (raw): ${excelDate}`);
      console.log(`  Excel Date (type): ${typeof excelDate}`);
      if (excelDate instanceof Date) {
        console.log(`  Excel Date (local): ${excelDate.getFullYear()}-${excelDate.getMonth() + 1}-${excelDate.getDate()}`);
      }
    }
    
    console.log('\n═══════════════════════════════════════');
    
  } catch (error) {
    console.error('\n❌ Import Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
};

importFirstOrder();

