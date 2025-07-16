// Test script for enhanced mobile number cleaning

// Function to clean and validate mobile numbers (same as in excel.serveces.controller.js)
const cleanAndValidateMobileNumber = (mobileData) => {
  let mobileNumbers = mobileData;
  
  // Handle case where mobileNumbers is already an array
  if (Array.isArray(mobileNumbers)) {
    mobileNumbers = mobileNumbers.join(' ');
  }
  
  // Convert to string and clean
  mobileNumbers = mobileNumbers
    .toString()
    .split(/[,\/\s]+/)
    .map((num) => num.replace(/\s+/g, "").replace(/^-+/, "").replace(/-+$/, "")) // Remove leading and trailing dashes
    .filter((num) => num && num.length > 0 && num !== "''" && num !== '""'); // Remove empty strings and quoted empty strings
  
  if (mobileNumbers.length === 0) {
    return { primaryNumber: null, alternateNumber: null, isInvalid: true, originalValue: mobileData };
  }
  
  let primaryNumber = mobileNumbers[0];
  let alternateNumber = mobileNumbers.length > 1 ? mobileNumbers[1] : null;
  
  // Try to combine partial numbers (like "88308 33233")
  if (primaryNumber && primaryNumber.length < 10 && alternateNumber && alternateNumber.length < 10) {
    const combined = primaryNumber + alternateNumber;
    if (combined.length === 10 && /^\d{10}$/.test(combined)) {
      primaryNumber = combined;
      alternateNumber = null;
    }
  }
  
  // Fix 9-digit numbers by adding a leading digit
  if (primaryNumber && primaryNumber.length === 9) {
    primaryNumber = '9' + primaryNumber; // Add leading 9
  }
  
  if (alternateNumber && alternateNumber.length === 9) {
    alternateNumber = '9' + alternateNumber; // Add leading 9
  }
  
  // Validate final numbers
  const isPrimaryValid = primaryNumber && /^\d{10}$/.test(primaryNumber);
  const isAlternateValid = alternateNumber && /^\d{10}$/.test(alternateNumber);
  
  return {
    primaryNumber: isPrimaryValid ? parseInt(primaryNumber, 10) : null,
    alternateNumber: isAlternateValid ? parseInt(alternateNumber, 10) : null,
    isInvalid: !isPrimaryValid,
    originalValue: mobileData
  };
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
  
  // Partial numbers that should be combined
  "88308 33233",
  "99709 74395",
  
  // 9-digit numbers that need fixing
  "986488990",
  "953904489",
  "921063399",
  
  // 11-digit numbers
  "98349225242",
  
  // Edge cases
  "",
  null,
  undefined,
  [],
  [""],
  ["", ""],
];

console.log('🧪 Testing enhanced mobile number cleaning logic:\n');

testCases.forEach((testCase, index) => {
  console.log(`Test ${index + 1}:`);
  console.log(`  Input: ${JSON.stringify(testCase)}`);
  
  try {
    const result = cleanAndValidateMobileNumber(testCase);
    console.log(`  Output:`, result);
    
    if (result.primaryNumber) {
      console.log(`  Primary: ${result.primaryNumber} ${result.isInvalid ? '❌' : '✅'}`);
    }
    
    if (result.alternateNumber) {
      console.log(`  Alternate: ${result.alternateNumber} ✅`);
    }
    
    if (result.isInvalid) {
      console.log(`  Status: Invalid phone - will use dummy number 9999999999`);
    }
    
  } catch (error) {
    console.log(`  Error: ${error.message} ❌`);
  }
  
  console.log('');
});

console.log('✅ Enhanced mobile number cleaning test completed!'); 