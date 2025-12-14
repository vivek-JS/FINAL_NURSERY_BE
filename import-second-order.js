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

const importSecondOrder = async () => {
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
    
    if (data.length < 2) {
      console.error('❌ Not enough rows in Excel file');
      process.exit(1);
    }
    
    // Get second row (index 1)
    const secondRow = data[1];
    console.log('\n📋 Second Row Data:');
    console.log('Booking NO.:', secondRow['Booking NO.']);
    console.log('Name:', secondRow['Name']);
    console.log('Expected Del. Date (raw):', secondRow['Expected\r\nDel.\r\nDate']);
    console.log('Expected Del. Date (type):', typeof secondRow['Expected\r\nDel.\r\nDate']);
    console.log('Del. Y/N:', secondRow['Del.\r\nY/N']);
    console.log('Date:', secondRow['Date']);
    
    // Create a new workbook with just the second row
    const newWorkbook = XLSX.utils.book_new();
    const newData = [secondRow];
    const newWorksheet = XLSX.utils.json_to_sheet(newData);
    XLSX.utils.book_append_sheet(newWorkbook, newWorksheet, 'Sheet1');
    
    // Convert to buffer
    const buffer = XLSX.write(newWorkbook, { type: 'buffer', bookType: 'xlsx' });
    
    console.log('\n🚀 Importing second order only...\n');
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
      const excelDateSerial = secondRow['Expected\r\nDel.\r\nDate'];
      if (typeof excelDateSerial === 'number') {
        const epoch = new Date(1899, 11, 30);
        const offsetDays = excelDateSerial;
        const offsetMilliseconds = offsetDays * 24 * 60 * 60 * 1000;
        const excelDate = new Date(epoch.getTime() + offsetMilliseconds);
        const excelDateIST = excelDate.toLocaleString('en-US', { 
          timeZone: 'Asia/Kolkata', 
          year: 'numeric', 
          month: '2-digit', 
          day: '2-digit' 
        });
        const [month, day, year] = excelDateIST.split('/').map(Number);
        console.log(`\n  Excel Date (serial ${excelDateSerial}): ${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`);
        console.log(`  Expected: Month ${month}, Day ${day}, Year ${year}`);
        
        if (deliveryDate.month() + 1 === month && deliveryDate.date() === day && deliveryDate.year() === year) {
          console.log(`  ✅ Date matches Excel!`);
        } else {
          console.log(`  ❌ Date does NOT match Excel!`);
        }
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

importSecondOrder();





