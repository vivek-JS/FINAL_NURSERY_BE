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

const importDec4Order = async () => {
  try {
    await connectDB();
    
    const filePath = path.join(__dirname, 'utility', 'watermelon Booking.xlsx');
    
    if (!fs.existsSync(filePath)) {
      console.error(`❌ File not found: ${filePath}`);
      process.exit(1);
    }
    
    console.log('\n📄 Reading Excel file...');
    const workbook = XLSX.readFile(filePath, { cellDates: true, raw: true });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { raw: true, dateNF: 'DD-MM-YYYY', defval: '' });
    
    // Find row with December 4 date
    const dec4Row = data.find(row => {
      const delDate = row['Expected\r\nDel.\r\nDate'];
      if (!delDate || !(delDate instanceof Date)) return false;
      const month = delDate.getMonth() + 1;
      const day = delDate.getDate();
      return month === 12 && day === 4;
    });
    
    if (!dec4Row) {
      console.error('❌ No row found with December 4 date');
      process.exit(1);
    }
    
    console.log('\n📋 December 4 Row Data:');
    console.log('Booking NO.:', dec4Row['Booking NO.']);
    console.log('Name:', dec4Row['Name']);
    const delDate = dec4Row['Expected\r\nDel.\r\nDate'];
    console.log('Expected Del. Date (raw):', delDate);
    console.log('Expected Del. Date (type):', typeof delDate);
    if (delDate instanceof Date) {
      console.log('  UTC parts:', delDate.getUTCFullYear(), delDate.getUTCMonth() + 1, delDate.getUTCDate());
      console.log('  Local parts:', delDate.getFullYear(), delDate.getMonth() + 1, delDate.getDate());
      console.log('  ISO:', delDate.toISOString());
    }
    console.log('Del. Y/N:', dec4Row['Del.\r\nY/N']);
    
    // Create a new workbook with just this row
    const newWorkbook = XLSX.utils.book_new();
    const newData = [dec4Row];
    const newWorksheet = XLSX.utils.json_to_sheet(newData);
    XLSX.utils.book_append_sheet(newWorkbook, newWorksheet, 'Sheet1');
    
    // Convert to buffer
    const buffer = XLSX.write(newWorkbook, { type: 'buffer', bookType: 'xlsx' });
    
    console.log('\n🚀 Importing December 4 order...\n');
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
      console.log(`\n  Expected: December 4, 2025 (Day: 4, Month: 12)`);
      if (deliveryDate.month() === 11 && deliveryDate.date() === 4) {
        console.log(`  ✅ Date is correct!`);
      } else {
        console.log(`  ❌ Date is WRONG! Should be December 4, but got Month ${deliveryDate.month() + 1}, Day ${deliveryDate.date()}`);
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

importDec4Order();




