import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Count rows in an Excel file
 * Usage: node count-excel-rows.js <path-to-excel-file>
 */

const countExcelRows = (filePath) => {
  try {
    // Resolve file path relative to script location
    const resolvedPath = path.isAbsolute(filePath) 
      ? filePath 
      : path.join(__dirname, filePath);

    // Check if file exists
    if (!fs.existsSync(resolvedPath)) {
      console.error(`❌ File not found: ${resolvedPath}`);
      return;
    }

    console.log(`📖 Reading Excel file: ${resolvedPath}`);

    // Read the Excel file
    const workbook = XLSX.readFile(resolvedPath, {
      cellDates: true,
      raw: true,
    });

    // Get the first sheet
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // Convert to JSON to count rows
    const data = XLSX.utils.sheet_to_json(worksheet, {
      raw: true,
      defval: null, // Use null for empty cells
    });

    // Count non-empty rows (rows with at least one non-empty cell)
    const totalRows = data.length;
    
    // Count rows with booking numbers (actual data rows)
    const rowsWithBooking = data.filter(row => {
      const bookingNo = row['Booking NO.'] || row['Booking NO'] || row['Booking NO.\r'] || row['Booking NO.\n'];
      return bookingNo && bookingNo.toString().trim() !== '';
    }).length;
    
    // Get the range of the sheet
    const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
    const totalExcelRows = range.e.r + 1; // Excel rows (1-indexed, includes header)
    const dataRows = totalExcelRows - 1; // Excluding header

    console.log('\n📊 Excel File Statistics:');
    console.log('─'.repeat(50));
    console.log(`📄 Sheet Name: ${sheetName}`);
    console.log(`📋 Total Excel Rows: ${totalExcelRows} (including header)`);
    console.log(`📝 Data Rows (excluding header): ${dataRows}`);
    console.log(`✅ Rows with data (JSON): ${totalRows}`);
    console.log(`📦 Rows with Booking Number: ${rowsWithBooking}`);
    console.log('─'.repeat(50));
    
    // Show sample of booking numbers to verify
    if (totalRows > 0) {
      console.log('\n📋 Sample Booking Numbers (first 10):');
      data.slice(0, 10).forEach((row, index) => {
        const bookingNo = row['Booking NO.'] || row['Booking NO'] || row['Booking NO.\r'] || row['Booking NO.\n'] || 'N/A';
        const name = row['Name'] || 'N/A';
        console.log(`   ${index + 1}. ${bookingNo} - ${name}`);
      });
      
      if (totalRows > 10) {
        console.log(`   ... and ${totalRows - 10} more rows`);
      }
    }

    return {
      totalExcelRows,
      dataRows,
      rowsWithData: totalRows,
      rowsWithBooking,
    };
  } catch (error) {
    console.error('❌ Error reading Excel file:', error.message);
    console.error(error.stack);
    return null;
  }
};

// Main execution
const filePath = process.argv[2];

if (!filePath) {
  console.log('Usage: node count-excel-rows.js <path-to-excel-file>');
  console.log('\nExample:');
  console.log('  node count-excel-rows.js "middlewares/BOOKING DETAILS 2025-26 (3).xlsx"');
  process.exit(1);
}

const result = countExcelRows(filePath);

if (result) {
  console.log(`\n✅ Total records to import: ${result.rowsWithData}`);
  console.log(`📊 Records with booking numbers: ${result.rowsWithBooking}`);
}



