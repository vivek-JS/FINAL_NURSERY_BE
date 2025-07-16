const axios = require('axios');

async function testOrderResponse() {
  try {
    // First get a fresh token
    const loginResponse = await axios.post('http://localhost:8000/api/v1/user/login', {
      phoneNumber: 7588686452,
      password: '432100'
    });

    if (loginResponse.data.status === 'error') {
      console.log('Login failed:', loginResponse.data.message);
      return;
    }

    const token = loginResponse.data.data.token;
    console.log('Got token successfully');

    // Test the orders API
    const ordersResponse = await axios.get('http://localhost:8000/api/v1/order/getOrders', {
      headers: {
        'Authorization': `Bearer ${token}`
      },
      params: {
        search: '',
        startDate: '01-01-2025',
        endDate: '04-10-2025',
        dispatched: 'false',
        limit: 1
      }
    });

    if (ordersResponse.data.status === 'success' && ordersResponse.data.data.length > 0) {
      const order = ordersResponse.data.data[0];
      console.log('\n=== ORDER RESPONSE TEST ===');
      console.log('Order ID:', order.orderId);
      console.log('Order Booking Date:', order.orderBookingDate);
      console.log('Created At:', order.createdAt);
      
      // Check if orderBookingDate is present
      if (order.orderBookingDate !== undefined) {
        console.log('✅ orderBookingDate field is present in response');
      } else {
        console.log('❌ orderBookingDate field is missing from response');
      }
      
      console.log('\nFull order fields:', Object.keys(order));
    } else {
      console.log('No orders found or API error:', ordersResponse.data);
    }

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

testOrderResponse(); 