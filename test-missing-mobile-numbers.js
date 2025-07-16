// Test handling of missing, empty, and dummy mobile numbers

const cleanAndValidateMobileNumber = (mobileData) => {
  let mobileNumbers = mobileData;
  
  // Handle case where mobileNumbers is already an array
  if (Array.isArray(mobileNumbers)) {
    mobileNumbers = mobileNumbers.join(' ');
  }
  
  // Convert to string and clean
  mobileNumbers = (mobileNumbers || "")
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

// Test cases for missing/empty/dummy mobile numbers
const testCases = [
  // Missing/empty cases
  null,
  undefined,
  "",
  "   ",
  "null",
  "undefined",
  
  // Dummy cases
  "dummy",
  "Dummy", 
  "DUMMY",
  "9999999999",
  9999999999,
  
  // Valid cases (for comparison)
  "9284775531",
  "986488990", // 9 digits - should be fixed
  "88308 33233", // partial - should be combined
];

console.log('🧪 Testing missing/empty/dummy mobile number handling:\n');

testCases.forEach((testCase, index) => {
  console.log(`Test ${index + 1}:`);
  console.log(`  Input: ${JSON.stringify(testCase)}`);
  
  // Check if it's missing/dummy first
  const isMissingOrDummy = !testCase || 
    testCase === "" || 
    testCase === null || 
    testCase === undefined ||
    testCase === "dummy" ||
    testCase === "Dummy" ||
    testCase === "DUMMY" ||
    testCase === "9999999999" ||
    testCase === 9999999999;
  
  if (isMissingOrDummy) {
    console.log(`  Status: ❌ Missing/Dummy - will use dummy number 9999999999`);
    console.log(`  Original: "${testCase || 'Missing'}"`);
  } else {
    const result = cleanAndValidateMobileNumber(testCase);
    console.log(`  Result:`, result);
    
    if (result.isInvalid) {
      console.log(`  Status: ❌ Invalid - will use dummy number 9999999999`);
    } else {
      console.log(`  Status: ✅ Valid - ${result.primaryNumber}`);
    }
  }
  
  console.log('');
});

console.log('✅ Missing/empty/dummy mobile number test completed!'); 