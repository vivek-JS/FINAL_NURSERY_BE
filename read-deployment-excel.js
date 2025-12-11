import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const readExcelFile = () => {
  try {
    // Path to the Excel file
    const excelFilePath = path.join(__dirname, 'deployment', 'BOOKING DETAILS 2025-26 (7).xlsx');
    
    // Check if file exists
    if (!fs.existsSync(excelFilePath)) {
      console.error('❌ Excel file not found at:', excelFilePath);
      return;
    }

    console.log('📖 Reading Excel file:', excelFilePath);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Try to read the Excel file
    // Note: xlsx library doesn't support password-protected files
    // If file is password-protected, you need to unlock it first
    let workbook;
    try {
      workbook = XLSX.readFile(excelFilePath, { 
        cellDates: true, 
        raw: false,
        sheetStubs: true 
      });
    } catch (error) {
      if (error.message && error.message.includes('password')) {
        console.error('❌ ERROR: File is password-protected!');
        console.log('\n💡 SOLUTION:');
        console.log('   The xlsx library cannot read password-protected files.');
        console.log('   Please unlock the file by following these steps:');
        console.log('   1. Open the Excel file in Microsoft Excel');
        console.log('   2. Enter the password when prompted');
        console.log('   3. Go to File > Info > Protect Workbook > Encrypt with Password');
        console.log('   4. Clear the password field and click OK');
        console.log('   5. Save the file');
        console.log('\n   Or export the data to an unlocked Excel/CSV file.\n');
        return;
      }
      throw error;
    }

    // Display workbook information
    console.log('📊 Workbook Information:');
    console.log('─────────────────────────────────────────');
    console.log(`Total Sheets: ${workbook.SheetNames.length}`);
    console.log(`Sheet Names: ${workbook.SheetNames.join(', ')}\n`);

    // Process each sheet
    workbook.SheetNames.forEach((sheetName, index) => {
      console.log(`\n📄 Sheet ${index + 1}: "${sheetName}"`);
      console.log('═══════════════════════════════════════════════');
      
      const worksheet = workbook.Sheets[sheetName];
      
      // Get the range of the sheet
      const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
      const totalRows = range.e.r + 1;
      const totalCols = range.e.c + 1;
      
      console.log(`Total Rows: ${totalRows}`);
      console.log(`Total Columns: ${totalCols}\n`);

      // Convert to JSON
      const data = XLSX.utils.sheet_to_json(worksheet, { 
        raw: false,
        defval: null,
        blankrows: false
      });

      if (data.length === 0) {
        console.log('⚠️  Sheet is empty\n');
        return;
      }

      // Display column headers
      const headers = Object.keys(data[0]);
      console.log(`📋 Column Headers (${headers.length}):`);
      headers.forEach((header, idx) => {
        console.log(`   ${idx + 1}. ${header}`);
      });
      console.log();

      // Display first 5 rows as sample
      console.log('📝 First 5 Rows (Sample):');
      console.log('─────────────────────────────────────────');
      const sampleRows = data.slice(0, 5);
      
      sampleRows.forEach((row, rowIdx) => {
        console.log(`\nRow ${rowIdx + 1}:`);
        headers.forEach(header => {
          const value = row[header];
          const displayValue = value !== null && value !== undefined 
            ? (String(value).length > 50 ? String(value).substring(0, 50) + '...' : String(value))
            : '(empty)';
          console.log(`   ${header}: ${displayValue}`);
        });
      });

      // Summary statistics
      console.log(`\n📈 Summary:`);
      console.log(`   Total Rows (with data): ${data.length}`);
      console.log(`   Rows with all empty cells: ${data.filter(row => Object.values(row).every(v => v === null || v === undefined || v === '')).length}`);
      
      // Count non-empty values per column
      console.log(`\n   Non-empty values per column:`);
      headers.forEach(header => {
        const nonEmptyCount = data.filter(row => {
          const val = row[header];
          return val !== null && val !== undefined && val !== '';
        }).length;
        const percentage = ((nonEmptyCount / data.length) * 100).toFixed(1);
        console.log(`   ${header}: ${nonEmptyCount}/${data.length} (${percentage}%)`);
      });

      // Save to JSON file for easier viewing
      const jsonOutputPath = path.join(__dirname, 'deployment', `excel-data-${sheetName.replace(/[^a-zA-Z0-9]/g, '_')}.json`);
      fs.writeFileSync(jsonOutputPath, JSON.stringify(data, null, 2), 'utf8');
      console.log(`\n💾 Full data saved to: ${jsonOutputPath}`);
    });

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Excel file reading completed!');
    
  } catch (error) {
    console.error('❌ Error reading Excel file:', error);
    console.error(error.stack);
  }
};

// Run the script
readExcelFile();

