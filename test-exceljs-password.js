import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testPassword() {
  try {
    const filePath = path.join(__dirname, 'fetch-excel', 'BOOKING DETAILS 2025-26 (8).xlsx');
    
    console.log('📄 Testing password: AV1312\n');
    
    const workbook = new ExcelJS.Workbook();
    
    // Try reading with password
    console.log('🔓 Attempting to read with ExcelJS and password AV1312...');
    await workbook.xlsx.readFile(filePath, { password: 'AV1312' });
    
    console.log('✅ Successfully opened workbook!');
    console.log('📋 Sheet names:', workbook.worksheets.map(s => s.name));
    
    const worksheet = workbook.worksheets[0];
    console.log(`\n📊 Sheet: ${worksheet.name}`);
    console.log(`   Rows: ${worksheet.rowCount}`);
    console.log(`   Columns: ${worksheet.columnCount}`);
    
    // Get headers
    console.log('\n📋 Headers (First Row):');
    const headers = [];
    worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
      headers[colNumber] = cell.value;
      console.log(`   ${colNumber}. ${cell.value}`);
    });
    
    // Get first 10 data rows
    console.log('\n📊 First 10 Data Rows:');
    for (let rowNum = 2; rowNum <= Math.min(11, worksheet.rowCount); rowNum++) {
      const row = worksheet.getRow(rowNum);
      console.log(`\nRow ${rowNum}:`);
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        if (headers[colNumber]) {
          console.log(`   ${headers[colNumber]}: ${cell.value}`);
        }
      });
    }
    
    // Convert to buffer
    console.log('\n🔄 Converting to buffer...');
    const buffer = await workbook.xlsx.writeBuffer();
    console.log('✅ Buffer created, size:', buffer.length, 'bytes');
    
    // Test reading with XLSX
    const xlsxWorkbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const data = XLSX.utils.sheet_to_json(xlsxWorkbook.Sheets[xlsxWorkbook.SheetNames[0]], { defval: null, header: 1 });
    console.log('✅ Successfully converted to XLSX format');
    console.log('📋 Total rows:', data.length);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.message.includes('password') || error.message.includes('Password')) {
      console.error('   Password might be incorrect');
    }
    console.error(error.stack);
  }
}

testPassword();





