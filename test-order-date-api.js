/**
 * Test script to verify deliveryDate is returned in getOrders API
 * Run: node test-order-date-api.js
 */

import axios from 'axios';

const BASE_URL = 'http://localhost:8000/api/v1';

// Use your actual token from the curl request
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2ODY5ZmYwNzllNTJlZmU2MTg0YWVjM2EiLCJwaG9uZU51bWJlciI6NzU4ODY4NjQ1Miwicm9sZSI6IlNVUEVSX0FETUlOIiwibmFtZSI6IlN1cGVyIEFkbWluIiwidHlwZSI6ImFjY2VzcyIsImlhdCI6MTc2MDc3MzU1MiwiZXhwIjoxNzYwODU5OTUyLCJhdWQiOiJudXJzZXJ5LXVzZXJzIiwiaXNzIjoibnVyc2VyeS1hcHAifQ.uYZG3X31Xpv2IKwovdsboymDEwC4ijbncTk9UN48X98';

async function testGetOrders() {
  try {
    console.log('🧪 Testing getOrders API for deliveryDate field...\n');

    const response = await axios.get(`${BASE_URL}/order/getOrders`, {
      params: {
        search: '',
        dispatched: false,
        limit: 10,
        page: 1,
        startDate: '16-10-2025',
        endDate: '18-10-2025'
      },
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/json'
      }
    });

    console.log('✅ API Response Status:', response.status);
    console.log('📊 Total Orders:', response.data?.data?.data?.length || 0);

    if (response.data?.data?.data?.length > 0) {
      const firstOrder = response.data.data.data[0];
      
      console.log('\n📋 First Order Fields Check:');
      console.log('─────────────────────────────────');
      console.log('Order ID:', firstOrder.orderId || 'Missing');
      console.log('Order Booking Date:', firstOrder.orderBookingDate || 'Missing');
      console.log('Delivery Date:', firstOrder.deliveryDate || 'Missing ❌');
      console.log('Booking Slot:', firstOrder.bookingSlot?.[0]?.startDay + ' - ' + firstOrder.bookingSlot?.[0]?.endDay || 'Missing');
      console.log('Order Status:', firstOrder.orderStatus || 'Missing');
      console.log('Order For:', firstOrder.orderFor ? 'Present ✅' : 'Not present');
      
      console.log('\n📝 Full First Order Data:');
      console.log(JSON.stringify(firstOrder, null, 2));
      
      // Check if deliveryDate exists
      if (firstOrder.deliveryDate) {
        console.log('\n✅ SUCCESS: deliveryDate field is present in API response!');
        console.log('📅 Delivery Date:', new Date(firstOrder.deliveryDate).toLocaleDateString());
      } else {
        console.log('\n❌ WARNING: deliveryDate field is MISSING in API response!');
        console.log('🔧 This might be because:');
        console.log('   1. Order was created before deliveryDate field was added');
        console.log('   2. Backend needs to be restarted');
        console.log('   3. Factory controller projection needs deliveryDate: 1');
      }
    } else {
      console.log('\n⚠️ No orders found in the specified date range');
      console.log('Try adjusting the date range or create a test order');
    }

  } catch (error) {
    console.error('\n❌ API Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
  }
}

// Run the test
testGetOrders();

