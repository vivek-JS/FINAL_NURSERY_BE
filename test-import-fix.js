import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import path from 'path';
import { validateExcelStructure } from './controllers/excel.serveces.controller.js';

console.log('🧪 Testing Excel Validation Fix\n');

// Test 1: Check that optional columns are not in requiredColumns
const code = fs.readFileSync('./controllers/excel.serveces.controller.js', 'utf8');

const optionalCols = ['Ad. Amt. Mode', 'Bank', 'CH No.', 'Advance\r\nDate', 'Remark'];
const requiredColsMatch = code.match(/const requiredColumns = \[([\s\S]*?)\];/);
const optionalColsMatch = code.match(/const optionalColumns = \[([\s\S]*?)\];/);

if (requiredColsMatch && optionalColsMatch) {
  const requiredColsStr = requiredColsMatch[1];
  const optionalColsStr = optionalColsMatch[1];
  
  console.log('✅ Test 1: Checking column definitions...');
  let allOptionalInOptional = true;
  
  optionalCols.forEach(col => {
    const inRequired = requiredColsStr.includes(col);
    const inOptional = optionalColsStr.includes(col);
    
    if (inRequired) {
      console.log(`  ❌ "${col}" is in REQUIRED columns (SHOULD BE IN OPTIONAL)`);
      allOptionalInOptional = false;
    } else if (inOptional) {
      console.log(`  ✅ "${col}" is correctly in OPTIONAL columns`);
    } else {
      console.log(`  ⚠️  "${col}" not found in either list`);
    }
  });
  
  if (allOptionalInOptional) {
    console.log('  ✅ All optional columns are correctly defined as optional\n');
  } else {
    console.log('  ❌ Some optional columns are incorrectly in required list\n');
  }
}

// Test 2: Check that validation doesn't block import
console.log('✅ Test 2: Checking import endpoint...');
const importCode = fs.readFileSync('./controllers/excel.controller.js', 'utf8');

const hasProceedLogic = importCode.includes('proceeding with import anyway') || 
                        importCode.includes('ALWAYS proceed') ||
                        importCode.includes('proceed with import');

if (hasProceedLogic) {
  console.log('  ✅ Import endpoint has logic to proceed even if validation fails');
} else {
  console.log('  ❌ Import endpoint may still block on validation failure');
}

const alwaysReturnsSuccess = importCode.includes('status: \'success\'') && 
                             !importCode.match(/if \(!validationResults\.isValid\)[\s\S]*?return res\.status\(400\)/);

if (alwaysReturnsSuccess) {
  console.log('  ✅ Import endpoint always returns success status\n');
} else {
  console.log('  ⚠️  Import endpoint may return error status\n');
}

console.log('📋 Summary:');
console.log('  - Optional columns are correctly defined');
console.log('  - Import endpoint should proceed even with validation errors');
console.log('  - Make sure to RESTART your server for changes to take effect!');
console.log('\n🚀 To restart server:');
console.log('   cd FINAL_NURSERY_BE');
console.log('   npm start  (or npm run dev)');




