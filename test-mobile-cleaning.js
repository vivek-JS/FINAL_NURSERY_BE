// Test script to verify mobile number cleaning logic

// Function to clean phone number (same as in excel.serveces.controller.js)
const cleanMobileNumbers = (mobileData) => {
  let mobileNumbers = mobileData;
  
  // Handle case where mobileNumbers is already an array
  if (Array.isArray(mobileNumbers)) {
    mobileNumbers = mobileNumbers.join(',');
  }
  
  // Convert to string and clean
  mobileNumbers = mobileNumbers
    .toString()
    .split(/[,\/\s]+/)
    .map((num) => num.replace(/\s+/g, "").replace(/^-+/, "").replace(/-+$/, "")) // Remove leading and trailing dashes
    .filter((num) => num && num.length > 0 && num !== "''" && num !== '""'); // Remove empty strings and quoted empty strings
  
  return mobileNumbers;
};

// Test cases
const testCases = [
  // Normal cases
  "9284775531",
  "9284775531, 9404558601",
  
  // Cases with dashes
  "-9284379330",
  "9284379330-",
  "-9284379330-",
  
  // Array cases
  ['', '88308', '33233'],
  ['9284775531', '9404558601'],
  ['-9284379330', '9404558601'],
  
  // Mixed cases
  "9284775531, -9404558601",
  "9284775531, '', 9404558601",
  
  // Edge cases
  "",
  null,
  undefined,
  [],
  [""],
  ["", ""],
];

console.log('🧪 Testing mobile number cleaning logic:\n');

testCases.forEach((testCase, index) => {
  console.log(`Test ${index + 1}:`);
  console.log(`  Input: ${JSON.stringify(testCase)}`);
  
  try {
    const result = cleanMobileNumbers(testCase);
    console.log(`  Output: ${JSON.stringify(result)}`);
    
    // Validate results
    if (result.length > 0) {
      const primary = result[0];
      const isValid = /^\d{10}$/.test(primary);
      console.log(`  Primary valid: ${isValid ? '✅' : '❌'} (${primary})`);
      
      if (result.length > 1) {
        const secondary = result[1];
        const secondaryValid = /^\d{10}$/.test(secondary);
        console.log(`  Secondary valid: ${secondaryValid ? '✅' : '❌'} (${secondary})`);
      }
    } else {
      console.log(`  Result: Empty array ❌`);
    }
  } catch (error) {
    console.log(`  Error: ${error.message} ❌`);
  }
  
  console.log('');
});

console.log('✅ Mobile number cleaning test completed!'); 