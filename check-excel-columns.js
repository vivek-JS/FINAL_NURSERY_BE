import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const filePath = path.join(__dirname, 'fetch-excel', 'latest_booking.xlsx');
const fileBuffer = fs.readFileSync(filePath);

const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: false });

console.log('Available sheets:', workbook.SheetNames);
console.log('Total sheets:', workbook.SheetNames.length);

// Check all sheets
for (const sheetName of workbook.SheetNames) {
  console.log(`\n\n=== Sheet: ${sheetName} ===`);
  const worksheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(worksheet, { defval: null, raw: true });
  
  if (data.length > 0) {
    console.log(`Rows in this sheet: ${data.length}`);
    console.log('Columns:', Object.keys(data[0]));
    console.log('First row:', JSON.stringify(data[0], null, 2));
  }
}

// Use first sheet for detailed analysis
const worksheet = workbook.Sheets[workbook.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(worksheet, { defval: null, raw: true });

console.log('Total rows:', data.length);
console.log('\nFirst 10 rows:');
for (let i = 0; i < Math.min(10, data.length); i++) {
  console.log(`\nRow ${i + 1}:`, JSON.stringify(data[i], null, 2));
}

// Check for booking-related columns by searching all rows
console.log('\n\nSearching for booking-related columns...');
let foundBookingColumns = false;
for (let i = 0; i < Math.min(50, data.length); i++) {
  const row = data[i];
  const keys = Object.keys(row);
  const values = Object.values(row).map(v => String(v || ''));
  
  // Look for common booking column names
  const bookingKeywords = ['Booking', 'Date', 'Name', 'Crop', 'Variety', 'Qty', 'Rate', 'Del', 'Media', 'Refrence'];
  const hasBookingKeywords = keys.some(k => 
    bookingKeywords.some(keyword => k.toLowerCase().includes(keyword.toLowerCase()))
  ) || values.some(v => 
    bookingKeywords.some(keyword => v.toLowerCase().includes(keyword.toLowerCase()))
  );
  
  if (hasBookingKeywords) {
    console.log(`\nFound potential booking header at row ${i + 1}:`);
    console.log('Keys:', keys);
    console.log('Sample values:', values.slice(0, 10));
    foundBookingColumns = true;
    break;
  }
}

if (!foundBookingColumns) {
  console.log('\n⚠️  No booking-related columns found in first 50 rows.');
  console.log('This appears to be a Cash Book file, not a booking orders file.');
  console.log('\nPlease check if you have the correct Excel file for booking orders.');
}

