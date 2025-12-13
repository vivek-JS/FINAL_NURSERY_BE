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

const importDec3Order = async () => {
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
    
    // Find row with December 3 date
    const dec3Row = data.find(row => {
      const delDate = row['Expected\r\nDel.\r\nDate'];
      if (!delDate || !(delDate instanceof Date)) return false;
      const month = delDate.getMonth() + 1;
      const day = delDate.getDate();
      return month === 12 && day === 3;
    });
    
    if (!dec3Row) {
      console.error('❌ No row found with December 3 date');
      process.exit(1);
    }
    
    console.log('\n📋 December 3 Row Data:');
    console.log('Booking NO.:', dec3Row['Booking NO.']);
    console.log('Name:', dec3Row['Name']);
    console.log('Expected Del. Date (raw):', dec3Row['Expected\r\nDel.\r\nDate']);
    console.log('Expected Del. Date (type):', typeof dec3Row['Expected\r\nDel.\r\nDate']);
    if (dec3Row['Expected\r\nDel.\r\nDate'] instanceof Date) {
      const d = dec3Row['Expected\r\nDel.\r\nDate'];
      console.log('  UTC parts:', d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      console.log('  Local parts:', d.getFullYear(), d.getMonth() + 1, d.getDate());
      console.log('  ISO:', d.toISOString());
    }
    console.log('Del. Y/N:', dec3Row['Del.\r\nY/N']);
    
    // Create a new workbook with just this row
    const newWorkbook = XLSX.utils.book_new();
    const newData = [dec3Row];
    const newWorksheet = XLSX.utils.json_to_sheet(newData);
    XLSX.utils.book_append_sheet(newWorkbook, newWorksheet, 'Sheet1');
    
    // Convert to buffer
    const buffer = XLSX.write(newWorkbook, { type: 'buffer', bookType: 'xlsx' });
    
    console.log('\n🚀 Importing December 3 order...\n');
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
      console.log(`\n  Expected: December 3, 2025 (Day: 3, Month: 12)`);
      if (deliveryDate.month() === 11 && deliveryDate.date() === 3) {
        console.log(`  ✅ Date is correct!`);
      } else {
        console.log(`  ❌ Date is WRONG! Should be December 3, but got Month ${deliveryDate.month() + 1}, Day ${deliveryDate.date()}`);
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

importDec3Order();




