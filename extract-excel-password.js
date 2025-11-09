import XLSX from 'xlsx';
import fs from 'fs';

console.log('📖 Reading password-protected Excel file...\n');

try {
  const filePath = 'booking.xlsx';
  
  // Try to read with password option
  const workbook = XLSX.readFile(filePath);
  
  console.log('✅ File read successfully!\n');
  console.log(`📋 Sheets found: ${workbook.SheetNames.length}\n`);
  
  workbook.SheetNames.forEach((sheetName, index) => {
    console.log(`${'='.repeat(80)}`);
    console.log(`📄 Sheet ${index + 1}: ${sheetName}`);
    console.log(`${'='.repeat(80)}\n`);
    
    const worksheet = workbook.Sheets[sheetName];
    
    // Convert to JSON
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: false });
    
    console.log(`Dimensions: ${jsonData.length} rows × ${jsonData.length > 0 ? Object.keys(jsonData[0]).length : 0} columns\n`);
    
    if (jsonData.length > 0) {
      // Show column names
      const headers = Object.keys(jsonData[0]);
      console.log(`Columns (${headers.length}): ${headers.slice(0, 15).join(', ')}`);
      if (headers.length > 15) {
        console.log(`... and ${headers.length - 15} more columns`);
      }
      
      console.log(`\n📊 Total data rows: ${jsonData.length}\n`);
      
      // Show first 5 rows
      console.log('First 5 rows of data:');
      for (let i = 0; i < Math.min(5, jsonData.length); i++) {
        const row = jsonData[i];
        const values = Object.values(row).slice(0, 10).map(v => String(v).substring(0, 25));
        console.log(`Row ${i + 1}: ${values.join(' | ')}`);
        if (headers.length > 10) {
          console.log(`     ... (${headers.length - 10} more columns)`);
        }
      }
    }
    
    console.log('\n');
  });
  
} catch (error) {
  console.error('❌ Error reading file:', error.message);
  
  if (error.message && error.message.includes('password')) {
    console.log('\n💡 The file is password protected.');
    console.log('The xlsx library does not support password-protected files.');
    console.log('You may need to:');
    console.log('  1. Remove the password from the file in Excel');
    console.log('  2. Or use a different tool that supports password-protected Excel files');
  }
}





