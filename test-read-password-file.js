import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testReadPasswordFile() {
  try {
    const XlsxPopulate = (await import('xlsx-populate')).default;
    const filePath = path.join(__dirname, 'fetch-excel', 'BOOKING DETAILS 2025-26 (8).xlsx');
    
    console.log('📄 Reading password-protected file:', filePath);
    console.log('🔐 Password: AV1412\n');
    
    // Try reading with xlsx-populate
    console.log('🔓 Attempting to read with xlsx-populate...');
    const workbook = await XlsxPopulate.fromFileAsync(filePath, { password: 'AV1412' });
    console.log('✅ Successfully opened workbook with xlsx-populate');
    
    // Get sheet names
    const sheetNames = workbook.sheetNames();
    console.log('📋 Sheet names:', sheetNames);
    
    // Get first sheet
    const sheet = workbook.sheet(0);
    const usedRange = sheet.usedRange();
    
    if (usedRange) {
      console.log(`\n📊 Used range: ${usedRange.address()}`);
      console.log(`   Rows: ${usedRange.endRowNumber() - usedRange.startRowNumber() + 1}`);
      console.log(`   Columns: ${usedRange.endColumnNumber() - usedRange.startRowNumber() + 1}`);
      
      // Get headers (first row)
      console.log('\n📋 Headers (First Row):');
      const headers = [];
      for (let col = usedRange.startColumnNumber(); col <= usedRange.endColumnNumber(); col++) {
        const cell = sheet.cell(1, col);
        const value = cell.value();
        headers.push(value);
        if (col <= 10) { // Show first 10 columns
          console.log(`   Column ${col}: ${value}`);
        }
      }
      
      // Get first 10 data rows
      console.log('\n📊 First 10 Data Rows:');
      for (let row = 2; row <= Math.min(11, usedRange.endRowNumber()); row++) {
        const rowData = [];
        for (let col = usedRange.startColumnNumber(); col <= usedRange.endColumnNumber(); col++) {
          const cell = sheet.cell(row, col);
          const value = cell.value();
          rowData.push(value);
        }
        console.log(`\nRow ${row}:`);
        headers.slice(0, 10).forEach((header, i) => {
          if (rowData[i] !== null && rowData[i] !== undefined) {
            console.log(`   ${header}: ${rowData[i]}`);
          }
        });
      }
    }
    
    // Try to convert to buffer and read with XLSX
    console.log('\n🔄 Converting to buffer for XLSX...');
    const outputBuffer = await workbook.outputAsync();
    console.log('✅ Converted to buffer, size:', outputBuffer.length, 'bytes');
    
    // Try reading with XLSX
    const xlsxWorkbook = XLSX.read(outputBuffer, { type: 'buffer', cellDates: false });
    const xlsxSheetName = xlsxWorkbook.SheetNames[0];
    const xlsxWorksheet = xlsxWorkbook.Sheets[xlsxSheetName];
    const data = XLSX.utils.sheet_to_json(xlsxWorksheet, { defval: null, header: 1 });
    
    console.log('\n✅ Successfully converted and read with XLSX');
    console.log('📋 Total rows:', data.length);
    console.log('\n📋 Headers:', JSON.stringify(data[0], null, 2));
    console.log('\n📊 First 3 data rows:');
    data.slice(1, 4).forEach((row, i) => {
      console.log(`\nRow ${i + 2}:`, JSON.stringify(row.slice(0, 10), null, 2));
    });
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  }
}

testReadPasswordFile();





