import dotenv from 'dotenv';
dotenv.config();

// Import the validation function
import { cleanAndValidateMobileNumber } from './controllers/excel.serveces.controller.js';

console.log('🧪 Testing 9-digit phone number validation...\n');

// Test cases
const testCases = [
  { input: '123456789', description: '9-digit number' },
  { input: '987654321', description: 'Another 9-digit number' },
  { input: '1234567890', description: '10-digit number (valid)' },
  { input: '12345678', description: '8-digit number' },
  { input: '12345678901', description: '11-digit number' },
  { input: '0', description: 'Single digit 0' },
  { input: '9999999999', description: 'Dummy number' },
  { input: '', description: 'Empty string' },
  { input: null, description: 'Null value' },
  { input: 'dummy', description: 'Dummy text' },
];

testCases.forEach((testCase, index) => {
  console.log(`Test ${index + 1}: ${testCase.description}`);
  console.log(`Input: "${testCase.input}"`);
  
  const result = cleanAndValidateMobileNumber(testCase.input);
  
  console.log(`Result:`);
  console.log(`  Primary Number: ${result.primaryNumber}`);
  console.log(`  Alternate Number: ${result.alternateNumber}`);
  console.log(`  Is Invalid: ${result.isInvalid}`);
  console.log(`  Original Value: "${result.originalValue}"`);
  console.log('---\n');
});

console.log('✅ Testing completed!'); 