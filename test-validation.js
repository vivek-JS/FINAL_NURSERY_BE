import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import path from 'path';
import { validateExcelStructure } from './controllers/excel.serveces.controller.js';

const testValidation = async () => {
  try {
    // Test with a sample file path (you can change this)
    const testFile = process.argv[2] || path.join(process.cwd(), 'deployment', 'watermelon Booking.xlsx');
    
    if (!fs.existsSync(testFile)) {
      console.log('❌ Test file not found:', testFile);
      console.log('Usage: node test-validation.js <path-to-excel-file>');
      return;
    }
    
    console.log('📖 Reading test file:', testFile);
    const buffer = fs.readFileSync(testFile);
    
    console.log('\n🔍 Running validation...\n');
    const results = validateExcelStructure(buffer);
    
    console.log('\n📊 Validation Results:');
    console.log('  isValid:', results.isValid);
    console.log('  errors:', results.errors);
    console.log('  warnings:', results.warnings);
    console.log('  rowErrors count:', results.rowErrors?.length || 0);
    
    if (results.isValid) {
      console.log('\n✅ Validation PASSED');
    } else {
      console.log('\n❌ Validation FAILED');
      console.log('   But import should still proceed!');
    }
    
  } catch (error) {
    console.error('❌ Test error:', error);
  }
};

testValidation();





