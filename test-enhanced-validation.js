// Test the enhanced mobile number cleaning with the actual problematic numbers

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

// Test the actual problematic numbers from your Excel
const testCases = [
  "986488990",        // Row 57 - 9 digits
  "953904489",        // Row 64 - 9 digits  
  "98349225242",      // Row 77 - 11 digits
  "921063399",        // Row 173 - 9 digits
  " 88308 33233",     // Row 325 - partial numbers
  "99709 74395",      // Row 349 - partial numbers
];

console.log('🧪 Testing enhanced mobile number cleaning with actual Excel data:\n');

testCases.forEach((testCase, index) => {
  const rowNumbers = [57, 64, 77, 173, 325, 349];
  console.log(`Row ${rowNumbers[index]}:`);
  console.log(`  Input: "${testCase}"`);
  
  const result = cleanAndValidateMobileNumber(testCase);
  console.log(`  Result:`, result);
  
  if (result.isInvalid) {
    console.log(`  Status: ❌ Invalid - will use dummy number 9999999999`);
  } else {
    console.log(`  Status: ✅ Valid - ${result.primaryNumber}`);
  }
  
  console.log('');
});

console.log('✅ Enhanced mobile number cleaning test completed!'); 