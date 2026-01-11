import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testReadWithExcelJS() {
  try {
    const filePath = path.join(__dirname, 'fetch-excel', 'BOOKING DETAILS 2025-26 (8).xlsx');
    
    console.log('📄 Reading password-protected file with ExcelJS...');
    console.log('🔐 Password: AV1412\n');
    
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath, { password: 'AV1412' });
    
    console.log('✅ Successfully opened workbook with ExcelJS');
    
    // Get sheet names
    console.log('📋 Sheet names:', workbook.worksheets.map(s => s.name));
    
    // Get first sheet
    const worksheet = workbook.worksheets[0];
    console.log(`\n📊 Sheet: ${worksheet.name}`);
    console.log(`   Rows: ${worksheet.rowCount}`);
    console.log(`   Columns: ${worksheet.columnCount}`);
    
    // Get headers (first row)
    console.log('\n📋 Headers (First Row):');
    const headers = [];
    worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
      headers[colNumber] = cell.value;
      if (colNumber <= 10) {
        console.log(`   Column ${colNumber}: ${cell.value}`);
      }
    });
    
    // Get first 10 data rows
    console.log('\n📊 First 10 Data Rows:');
    for (let rowNum = 2; rowNum <= Math.min(11, worksheet.rowCount); rowNum++) {
      const row = worksheet.getRow(rowNum);
      console.log(`\nRow ${rowNum}:`);
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        if (colNumber <= 10 && headers[colNumber]) {
          console.log(`   ${headers[colNumber]}: ${cell.value}`);
        }
      });
    }
    
    // Convert to buffer for XLSX compatibility
    console.log('\n🔄 Converting to buffer for XLSX compatibility...');
    const buffer = await workbook.xlsx.writeBuffer();
    console.log('✅ Converted to buffer, size:', buffer.length, 'bytes');
    
    // Try reading with XLSX
    const xlsxWorkbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const xlsxSheetName = xlsxWorkbook.SheetNames[0];
    const xlsxWorksheet = xlsxWorkbook.Sheets[xlsxSheetName];
    const data = XLSX.utils.sheet_to_json(xlsxWorksheet, { defval: null, header: 1 });
    
    console.log('\n✅ Successfully converted and read with XLSX');
    console.log('📋 Total rows:', data.length);
    console.log('\n📋 Headers:', JSON.stringify(data[0], null, 2));
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.message.includes('password') || error.message.includes('Password')) {
      console.error('   The password might be incorrect or the file uses a different encryption method.');
    }
    console.error(error.stack);
  }
}

testReadWithExcelJS();




