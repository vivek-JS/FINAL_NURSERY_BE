import XlsxPopulate from '@eyeseetea/xlsx-populate';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testRead() {
  try {
    const filePath = path.join(__dirname, 'fetch-excel', 'BOOKING DETAILS 2025-26 (8).xlsx');
    
    console.log('📄 Reading with @eyeseetea/xlsx-populate...');
    console.log('🔐 Password: AV1312\n');
    
    const workbook = await XlsxPopulate.fromFileAsync(filePath, { password: 'AV1312' });
    console.log('✅ Successfully opened workbook!');
    
    const sheet = workbook.sheet(0);
    const usedRange = sheet.usedRange();
    
    if (usedRange) {
      console.log(`📊 Used range: ${usedRange.address()}`);
      const rowCount = usedRange.endCell().rowNumber();
      console.log(`   Total rows: ${rowCount}`);
      
      // Get headers
      console.log('\n📋 Headers (First Row):');
      const headers = [];
      for (let col = usedRange.startCell().columnNumber(); col <= usedRange.endCell().columnNumber(); col++) {
        const cell = sheet.cell(1, col);
        const value = cell.value();
        headers[col] = value;
        if (col <= 15) {
          console.log(`   ${col}. ${value}`);
        }
      }
      
      // Get first 10 data rows
      console.log('\n📊 First 10 Data Rows:');
      for (let row = 2; row <= Math.min(11, rowCount); row++) {
        console.log(`\nRow ${row}:`);
        for (let col = usedRange.startCell().columnNumber(); col <= Math.min(usedRange.endCell().columnNumber(), usedRange.startCell().columnNumber() + 14); col++) {
          const cell = sheet.cell(row, col);
          const value = cell.value();
          if (headers[col] && value !== null && value !== undefined) {
            console.log(`   ${headers[col]}: ${value}`);
          }
        }
      }
    }
    
    // Convert to buffer for XLSX
    console.log('\n🔄 Converting to buffer...');
    const buffer = await workbook.outputAsync();
    console.log('✅ Buffer created, size:', buffer.length, 'bytes');
    
    // Read with XLSX
    const xlsxWorkbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const data = XLSX.utils.sheet_to_json(xlsxWorkbook.Sheets[xlsxWorkbook.SheetNames[0]], { defval: null, header: 1 });
    console.log('✅ Successfully converted to XLSX format');
    console.log('📋 Total rows:', data.length);
    
    return buffer;
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    throw error;
  }
}

testRead();





