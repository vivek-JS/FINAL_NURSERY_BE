import axios from 'axios';

/**
 * Test script to verify automatic farmer creation from orderFor data
 * Tests:
 * 1. Creating an order with orderFor data (name + mobileNumber)
 * 2. Verifying a new farmer was created
 * 3. Testing duplicate prevention (same mobile number)
 */
async function testOrderForFarmerCreation() {
  const baseURL = 'http://localhost:8000/api/v1';
  
  // You'll need to update this token - get it from login
  const authToken = 'YOUR_AUTH_TOKEN_HERE';

  const headers = {
    'Authorization': `Bearer ${authToken}`,
    'Content-Type': 'application/json'
  };

  try {
    console.log('🧪 Testing Automatic Farmer Creation from orderFor Data...\n');

    // Generate unique mobile number for testing
    const uniqueMobileNumber = 9000000000 + Math.floor(Math.random() * 999999);
    
    // Test 1: Create order with orderFor data
    console.log('📝 Test 1: Creating order with orderFor data...');
    
    const orderPayload = {
      // Main farmer data (the person placing the order)
      name: "Test Main Farmer",
      village: "Test Village",
      taluka: "Test Taluka", 
      district: "Test District",
      state: "Maharashtra",
      stateName: "Maharashtra",
      districtName: "Test District",
      talukaName: "Test Taluka",
      mobileNumber: 8000000000 + Math.floor(Math.random() * 999999),
      
      // Order details
      numberOfPlants: 10,
      rate: 25,
      salesPerson: "YOUR_SALES_PERSON_ID", // Update with valid ID
      orderStatus: "ACCEPTED",
      plantName: "YOUR_PLANT_ID", // Update with valid ID
      plantSubtype: "YOUR_SUBTYPE_ID", // Update with valid ID
      bookingSlot: "YOUR_SLOT_ID", // Update with valid ID
      orderPaymentStatus: "PENDING",
      orderBookingDate: new Date().toISOString(),
      
      // Order For data - This should create a new farmer
      orderFor: {
        name: "Secondary Farmer (OrderFor)",
        address: "456 Test Address, Test City, Maharashtra",
        mobileNumber: uniqueMobileNumber
      }
    };

    console.log('Order For Data:', orderPayload.orderFor);
    console.log('Unique Mobile:', uniqueMobileNumber);

    const createResponse = await axios.post(
      `${baseURL}/farmer/createFarmer`, 
      orderPayload, 
      { headers }
    );
    
    if (createResponse.data.status === 'Success') {
      console.log('✅ Order created successfully!');
      console.log('Order ID:', createResponse.data.data.order?._id);
      
      // Test 2: Check if farmer was created with the orderFor mobile number
      console.log('\n📖 Test 2: Checking if farmer was created from orderFor...');
      
      // Wait a moment for database to sync
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const farmerCheckResponse = await axios.get(
        `${baseURL}/farmer/find/${uniqueMobileNumber}`,
        { headers }
      );
      
      if (farmerCheckResponse.data.status === 'success') {
        console.log('✅ SUCCESS: Farmer was created from orderFor data!');
        console.log('Farmer Details:');
        console.log('  - Name:', farmerCheckResponse.data.data.name);
        console.log('  - Mobile:', farmerCheckResponse.data.data.mobileNumber);
        console.log('  - Village (Address):', farmerCheckResponse.data.data.village);
        console.log('  - Farmer ID:', farmerCheckResponse.data.data._id);
      } else {
        console.log('❌ ISSUE: Farmer was not created from orderFor data');
        console.log('Response:', farmerCheckResponse.data);
      }
      
      // Test 3: Create another order with same mobile number (should not duplicate)
      console.log('\n🔄 Test 3: Testing duplicate prevention (same mobile number)...');
      
      const duplicateOrderPayload = {
        ...orderPayload,
        mobileNumber: 8000000000 + Math.floor(Math.random() * 999999), // Different main farmer
        orderFor: {
          name: "Same Person Different Name",
          address: "Different Address",
          mobileNumber: uniqueMobileNumber // Same mobile as before
        }
      };
      
      const duplicateResponse = await axios.post(
        `${baseURL}/farmer/createFarmer`,
        duplicateOrderPayload,
        { headers }
      );
      
      if (duplicateResponse.data.status === 'Success') {
        console.log('✅ Second order created successfully');
        
        // Check farmer count
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const farmerCheckAgain = await axios.get(
          `${baseURL}/farmer/find/${uniqueMobileNumber}`,
          { headers }
        );
        
        if (farmerCheckAgain.data.status === 'success') {
          console.log('✅ SUCCESS: No duplicate farmer created!');
          console.log('Farmer still has original name:', farmerCheckAgain.data.data.name);
        }
      }
      
      console.log('\n✨ All tests completed successfully!');
      
    } else {
      console.log('❌ Failed to create order:', createResponse.data);
    }

  } catch (error) {
    console.error('❌ Test failed with error:');
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    } else {
      console.error('Error message:', error.message);
    }
  }
}

// Instructions
console.log('⚠️  SETUP INSTRUCTIONS:');
console.log('1. Make sure the backend server is running on http://localhost:8000');
console.log('2. Update the authToken with a valid JWT token (login first)');
console.log('3. Update the IDs (salesPerson, plantName, plantSubtype, bookingSlot)');
console.log('4. Run: node test-orderfor-farmer-creation.js\n');

// Uncomment to run the test
// testOrderForFarmerCreation();

