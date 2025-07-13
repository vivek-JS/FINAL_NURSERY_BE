import axios from 'axios';

const BASE_URL = 'http://localhost:8000/api/v1';

// Test login to get token
async function testLogin() {
  try {
    const response = await axios.post(`${BASE_URL}/user/login`, {
      phoneNumber: 7588686452,
      password: 'admin123'
    });
    
    if (response.data.success) {
      return response.data.data.accessToken;
    }
  } catch (error) {
    console.error('Login failed:', error.response?.data || error.message);
  }
  return null;
}

// Test inventory endpoints
async function testInventoryEndpoints(token) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  console.log('Testing Inventory Endpoints...\n');

  // Test dashboard
  try {
    const dashboardResponse = await axios.get(`${BASE_URL}/inventory/dashboard`, { headers });
    console.log('✅ Dashboard endpoint working:', dashboardResponse.data.success);
  } catch (error) {
    console.log('❌ Dashboard endpoint failed:', error.response?.data?.message || error.message);
  }

  // Test products
  try {
    const productsResponse = await axios.get(`${BASE_URL}/inventory/products`, { headers });
    console.log('✅ Products endpoint working:', productsResponse.data.success);
  } catch (error) {
    console.log('❌ Products endpoint failed:', error.response?.data?.message || error.message);
  }

  // Test batches
  try {
    const batchesResponse = await axios.get(`${BASE_URL}/inventory/batches`, { headers });
    console.log('✅ Batches endpoint working:', batchesResponse.data.success);
  } catch (error) {
    console.log('❌ Batches endpoint failed:', error.response?.data?.message || error.message);
  }

  // Test inwards
  try {
    const inwardsResponse = await axios.get(`${BASE_URL}/inventory/inwards`, { headers });
    console.log('✅ Inwards endpoint working:', inwardsResponse.data.success);
  } catch (error) {
    console.log('❌ Inwards endpoint failed:', error.response?.data?.message || error.message);
  }

  // Test outwards
  try {
    const outwardsResponse = await axios.get(`${BASE_URL}/inventory/outwards`, { headers });
    console.log('✅ Outwards endpoint working:', outwardsResponse.data.success);
  } catch (error) {
    console.log('❌ Outwards endpoint failed:', error.response?.data?.message || error.message);
  }
}

// Run tests
async function runTests() {
  console.log('🔐 Logging in...');
  const token = await testLogin();
  
  if (token) {
    console.log('✅ Login successful\n');
    await testInventoryEndpoints(token);
  } else {
    console.log('❌ Login failed, cannot test endpoints');
  }
}

runTests().catch(console.error); 