import axios from 'axios';

// Test script to verify Order For functionality
async function testOrderForAPI() {
  const baseURL = 'http://localhost:8000/api/v1';
  const authToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2ODY5ZmYwNzllNTJlZmU2MTg0YWVjM2EiLCJwaG9uZU51bWJlciI6NzU4ODY4NjQ1Miwicm9sZSI6IlNVUEVSX0FETUlOIiwibmFtZSI6IlN1cGVyIEFkbWluIiwidHlwZSI6ImFjY2VzcyIsImlhdCI6MTc1OTY0NzIzNiwiZXhwIjoxNzU5NzMzNjM2LCJhdWQiOiJudXJzZXJ5LXVzZXJzIiwiaXNzIjoibnVyc2VyeS1hcHAifQ.JnFrQcAjTq-C6XpJHOJtslHMgVvIO0i7E6F0riSc3HQ';

  const headers = {
    'Authorization': `Bearer ${authToken}`,
    'Content-Type': 'application/json'
  };

  try {
    console.log('🧪 Testing Order For API Implementation...\n');

    // Test 1: Create a test order with Order For data
    console.log('📝 Test 1: Creating order with Order For data...');
    
    const orderPayload = {
      name: "Test Farmer",
      village: "Test Village",
      taluka: "Test Taluka", 
      district: "Test District",
      state: "Maharashtra",
      stateName: "Maharashtra",
      districtName: "Test District",
      talukaName: "Test Taluka",
      mobileNumber: 9876543210,
      typeOfPlants: "Test Plants",
      numberOfPlants: 10,
      rate: 25,
      paymentStatus: "not paid",
      salesPerson: "687d107e8ed13471446242a9", // Use existing sales person ID
      orderStatus: "ACCEPTED",
      plantName: "688f3675198b3cd86a8e24a8", // Use existing plant ID
      plantSubtype: "688f3675198b3cd86a8e24aa", // Use existing subtype ID
      bookingSlot: "688f37f4198b3cd86a8e2543", // Use existing slot ID
      orderPaymentStatus: "PENDING",
      cavity: "6872aac27ef8a7608cebbdcf", // Use existing cavity ID
      orderBookingDate: new Date().toISOString(),
      // Order For data
      orderFor: {
        name: "John Doe",
        address: "123 Test Street, Test City, Test State",
        mobileNumber: 9876543210
      }
    };

    console.log('Order payload with Order For:', JSON.stringify(orderPayload, null, 2));

    const createResponse = await axios.post(`${baseURL}/farmer/createFarmer`, orderPayload, { headers });
    
    if (createResponse.data.status === 'Success') {
      console.log('✅ Order created successfully!');
      console.log('Order ID:', createResponse.data.data.order._id);
      
      const orderId = createResponse.data.data.order._id;
      
      // Test 2: Retrieve the created order to verify Order For data is returned
      console.log('\n📖 Test 2: Retrieving order to verify Order For data...');
      
      const getOrdersResponse = await axios.get(`${baseURL}/order/getOrders?limit=10000&page=1`, { headers });
      
      if (getOrdersResponse.data.status === 'Success') {
        console.log('✅ Orders retrieved successfully!');
        
        // Find our test order
        const orders = getOrdersResponse.data.data.data;
        const testOrder = orders.find(order => order.farmer?.name === "Test Farmer");
        
        if (testOrder) {
          console.log('\n🔍 Test Order Found:');
          console.log('Order ID:', testOrder._id);
          console.log('Farmer Name:', testOrder.farmer?.name);
          console.log('Order For Data:', testOrder.orderFor);
          
          if (testOrder.orderFor) {
            console.log('✅ SUCCESS: Order For data is present in API response!');
            console.log('Order For Details:');
            console.log('  - Name:', testOrder.orderFor.name);
            console.log('  - Address:', testOrder.orderFor.address);
            console.log('  - Mobile:', testOrder.orderFor.mobileNumber);
          } else {
            console.log('❌ ISSUE: Order For data is missing from API response');
            console.log('Available fields:', Object.keys(testOrder));
          }
        } else {
          console.log('❌ Test order not found in retrieved orders');
        }
      } else {
        console.log('❌ Failed to retrieve orders:', getOrdersResponse.data);
      }
      
    } else {
      console.log('❌ Failed to create order:', createResponse.data);
    }

    // Test 3: Test getOrdersBySlot endpoint
    console.log('\n🎯 Test 3: Testing getOrdersBySlot endpoint...');
    
    const slotResponse = await axios.get(`${baseURL}/order/getOrdersBySlot/688f37f4198b3cd86a8e2543`, { headers });
    
    if (slotResponse.data.status === 'Success') {
      console.log('✅ Orders by slot retrieved successfully!');
      
      const slotOrders = slotResponse.data.orders;
      const testSlotOrder = slotOrders.find(order => order.farmer?.name === "Test Farmer");
      
      if (testSlotOrder) {
        console.log('🔍 Test Order in Slot Response:');
        console.log('Order For Data:', testSlotOrder.orderFor);
        
        if (testSlotOrder.orderFor) {
          console.log('✅ SUCCESS: Order For data is present in slot API response!');
        } else {
          console.log('❌ ISSUE: Order For data is missing from slot API response');
        }
      }
    } else {
      console.log('❌ Failed to retrieve orders by slot:', slotResponse.data);
    }

  } catch (error) {
    console.error('❌ Test failed with error:', error.response?.data || error.message);
  }
}

// Run the test
testOrderForAPI();
