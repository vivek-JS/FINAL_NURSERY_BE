import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try to read password-protected Excel file
async function readPasswordProtectedExcel(filePath, password) {
  try {
    // Try xlsx-populate for password-protected files
    const XlsxPopulate = (await import('xlsx-populate')).default;
    
    const workbook = await XlsxPopulate.fromFileAsync(filePath, { password });
    const outputBuffer = await workbook.outputAsync();
    
    // Now read with XLSX
    const processedWorkbook = XLSX.read(outputBuffer, { type: 'buffer', cellDates: false });
    return processedWorkbook;
  } catch (error) {
    throw error;
  }
}

async function readExcelFile() {
  const filePath = path.join(__dirname, 'fetch-excel', 'BOOKING DETAILS 2025-26 (8).xlsx');
  
  console.log('📄 Reading Excel file:', filePath);
  console.log('File exists:', fs.existsSync(filePath));
  
  // Try without password first
  try {
    console.log('\n🔓 Attempting to read without password...');
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { defval: null, header: 1 });
    
    console.log('✅ File is NOT password-protected');
    console.log('Sheet Name:', sheetName);
    console.log('Total Rows:', data.length);
    console.log('\n📋 Headers (First Row):');
    console.log(JSON.stringify(data[0], null, 2));
    console.log('\n📊 First 3 Data Rows:');
    data.slice(1, 4).forEach((row, i) => {
      console.log(`\nRow ${i + 2}:`);
      console.log(JSON.stringify(row, null, 2));
    });
  } catch (error) {
    if (error.message && error.message.includes('password')) {
      console.log('🔐 File is password-protected');
      console.log('\n⚠️  Please provide the password to read this file.');
      console.log('Usage: node read-fetch-excel.js <password>');
      
      // If password provided as argument, try with it
      const password = process.argv[2];
      if (password) {
        console.log(`\n🔓 Attempting to read with provided password...`);
        try {
          const workbook = await readPasswordProtectedExcel(filePath, password);
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          const data = XLSX.utils.sheet_to_json(worksheet, { defval: null, header: 1 });
          
          console.log('✅ Successfully decrypted and read file!');
          console.log('Sheet Name:', sheetName);
          console.log('Total Rows:', data.length);
          console.log('\n📋 Headers (First Row):');
          console.log(JSON.stringify(data[0], null, 2));
          console.log('\n📊 First 3 Data Rows:');
          data.slice(1, 4).forEach((row, i) => {
            console.log(`\nRow ${i + 2}:`);
            console.log(JSON.stringify(row, null, 2));
          });
        } catch (passwordError) {
          console.error('❌ Error reading with password:', passwordError.message);
        }
      }
    } else {
      console.error('❌ Error:', error.message);
    }
  }
}

readExcelFile().catch(console.error);




