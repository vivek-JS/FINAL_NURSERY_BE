import axios from 'axios';

const BASE_URL = 'http://192.168.1.30:8000/api/v1';

// Test function to verify role-based order filtering
async function testRoleBasedOrders() {
  console.log('🧪 Testing Role-Based Order Filtering...\n');

  try {
    // Test 1: Login as a SALES user
    console.log('1️⃣ Testing SALES user login...');
    const salesLoginResponse = await axios.post(`${BASE_URL}/user/login`, {
      phoneNumber: 9876543210, // Test SALES user phone
      password: '12345678'
    });
    
    if (salesLoginResponse.data.status === 'Success') {
      const salesToken = salesLoginResponse.data.data.accessToken;
      console.log('✅ SALES user logged in successfully');
      
      // Test getOrders with SALES user
      const salesOrdersResponse = await axios.get(`${BASE_URL}/order/getOrders?limit=5`, {
        headers: {
          'Authorization': `Bearer ${salesToken}`
        }
      });
      
      console.log(`📊 SALES user can see ${salesOrdersResponse.data.data?.length || 0} orders`);
      console.log('📋 Sample order data:', salesOrdersResponse.data.data?.[0] ? {
        orderId: salesOrdersResponse.data.data[0].orderId,
        salesPerson: salesOrdersResponse.data.data[0].salesPerson,
        dealer: salesOrdersResponse.data.data[0].dealer
      } : 'No orders found');
    } else {
      console.log('❌ SALES user login failed');
    }

    console.log('\n' + '='.repeat(50) + '\n');

    // Test 2: Login as a DEALER user
    console.log('2️⃣ Testing DEALER user login...');
    const dealerLoginResponse = await axios.post(`${BASE_URL}/user/login`, {
      phoneNumber: 9999999999, // Test DEALER user phone
      password: '12345678'
    });
    
    if (dealerLoginResponse.data.status === 'Success') {
      const dealerToken = dealerLoginResponse.data.data.accessToken;
      console.log('✅ DEALER user logged in successfully');
      
      // Test getOrders with DEALER user
      const dealerOrdersResponse = await axios.get(`${BASE_URL}/order/getOrders?limit=5`, {
        headers: {
          'Authorization': `Bearer ${dealerToken}`
        }
      });
      
      console.log(`📊 DEALER user can see ${dealerOrdersResponse.data.data?.length || 0} orders`);
      console.log('📋 Sample order data:', dealerOrdersResponse.data.data?.[0] ? {
        orderId: dealerOrdersResponse.data.data[0].orderId,
        salesPerson: dealerOrdersResponse.data.data[0].salesPerson,
        dealer: dealerOrdersResponse.data.data[0].dealer
      } : 'No orders found');
    } else {
      console.log('❌ DEALER user login failed');
    }

    console.log('\n' + '='.repeat(50) + '\n');

    // Test 3: Login as ADMIN user
    console.log('3️⃣ Testing ADMIN user login...');
    const adminLoginResponse = await axios.post(`${BASE_URL}/user/login`, {
      phoneNumber: 7588686452, // SUPER_ADMIN user phone
      password: 'passsword123443'
    });
    
    if (adminLoginResponse.data.status === 'Success') {
      const adminToken = adminLoginResponse.data.data.accessToken;
      console.log('✅ ADMIN user logged in successfully');
      
      // Test getOrders with ADMIN user
      const adminOrdersResponse = await axios.get(`${BASE_URL}/order/getOrders?limit=5`, {
        headers: {
          'Authorization': `Bearer ${adminToken}`
        }
      });
      
      console.log(`📊 ADMIN user can see ${adminOrdersResponse.data.data?.length || 0} orders`);
      console.log('📋 Sample order data:', adminOrdersResponse.data.data?.[0] ? {
        orderId: adminOrdersResponse.data.data[0].orderId,
        salesPerson: adminOrdersResponse.data.data[0].salesPerson,
        dealer: adminOrdersResponse.data.data[0].dealer
      } : 'No orders found');
    } else {
      console.log('❌ ADMIN user login failed');
    }

    console.log('\n' + '='.repeat(50) + '\n');
    console.log('🎯 Role-based filtering test completed!');
    console.log('\n📝 Expected behavior:');
    console.log('• SALES users should only see orders where salesPerson = their user ID');
    console.log('• DEALER users should only see orders where dealer = their user ID');
    console.log('• ADMIN/SUPER_ADMIN/OFFICE_ADMIN users should see all orders');

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
  }
}

// Run the test
testRoleBasedOrders();
