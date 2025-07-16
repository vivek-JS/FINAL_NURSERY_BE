import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

// Function to test Excel column structure
const testExcelColumns = () => {
  try {
    // Path to the Excel file
    const excelFilePath = path.join(process.cwd(), 'deployment', 'Booking Sep To Feb.xlsx');
    
    // Check if file exists
    if (!fs.existsSync(excelFilePath)) {
      console.error('❌ Excel file not found at:', excelFilePath);
      console.log('Please make sure the file "Booking Sep To Feb.xlsx" is in the deployment folder');
      return;
    }

    console.log('📖 Reading Excel file:', excelFilePath);

    // Read the Excel file
    const workbook = XLSX.readFile(excelFilePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    console.log(`📊 Found ${data.length} rows in the Excel file`);

    // Get the first row to see all columns
    const firstRow = data[0];
    const columns = Object.keys(firstRow);
    
    console.log('\n📋 All available columns:');
    columns.forEach((col, index) => {
      console.log(`${String.fromCharCode(65 + index)}: "${col}"`);
    });

    // Check for required columns based on new structure
    const requiredColumns = [
      "Date",           // A
      "Booking NO.",    // B
      "Name",           // C
      "Mobile No.",     // D
      "Village",        // E
      "Taluka",         // F
      "District",       // G
      "Advance\r\nAmt.", // J
      "Crop",           // K
      "Variety",        // L
      "Media",          // M
      "Plant Qty.",     // O
      "Rate",           // P
      "Expected\r\nDel.\r\nDate", // Q
      "Order\r\nBy",    // W
      "Ad. Amt. Mode",  // AA
      "Bank",           // AB
      "CH No.",         // AC
      "Advance\r\nDate", // AD
      "Remark"          // AJ
    ];

    console.log('\n🔍 Checking required columns:');
    const missingColumns = [];
    const foundColumns = [];

    requiredColumns.forEach(col => {
      if (columns.includes(col)) {
        foundColumns.push(col);
        console.log(`✅ Found: "${col}"`);
      } else {
        missingColumns.push(col);
        console.log(`❌ Missing: "${col}"`);
      }
    });

    console.log('\n📊 Summary:');
    console.log(`✅ Found columns: ${foundColumns.length}/${requiredColumns.length}`);
    console.log(`❌ Missing columns: ${missingColumns.length}`);

    if (missingColumns.length > 0) {
      console.log('\n❌ Missing columns:');
      missingColumns.forEach(col => {
        console.log(`   - "${col}"`);
      });
    }

    // Show sample data for first row
    if (data.length > 0) {
      console.log('\n📝 Sample data from first row:');
      const sampleRow = data[0];
      requiredColumns.forEach(col => {
        if (sampleRow[col] !== undefined) {
          console.log(`   "${col}": "${sampleRow[col]}"`);
        }
      });
    }

    // Check for sales person data in columns W and X
    if (columns.length >= 24) {
      const columnW = columns[22]; // Column W (23rd column, 0-indexed: 22)
      const columnX = columns[23]; // Column X (24th column, 0-indexed: 23)
      
      console.log('\n👥 Sales person columns (W & X):');
      console.log(`W: "${columnW}"`);
      console.log(`X: "${columnX}"`);
      
      // Show sample sales person data
      if (data.length > 0) {
        const sampleRow = data[0];
        console.log(`Sample W value: "${sampleRow[columnW]}"`);
        console.log(`Sample X value: "${sampleRow[columnX]}"`);
      }
    }

  } catch (error) {
    console.error('❌ Error testing Excel columns:', error);
  }
};

// Run the test
testExcelColumns(); 