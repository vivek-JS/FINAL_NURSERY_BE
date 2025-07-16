const axios = require('axios');

const BASE_URL = 'http://localhost:8000/api/v1';

// Test the invalid phone farmers endpoint
async function testInvalidPhoneFarmers() {
  try {
    console.log('Testing GET /farmer/invalid-phones...');
    const response = await axios.get(`${BASE_URL}/farmer/invalid-phones`);
    console.log('Response:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error testing invalid phone farmers endpoint:', error.response?.data || error.message);
  }
}

// Test the update farmer phone endpoint
async function testUpdateFarmerPhone(farmerId, phoneNumber) {
  try {
    console.log(`Testing PUT /farmer/${farmerId}/phone...`);
    const response = await axios.put(`${BASE_URL}/farmer/${farmerId}/phone`, {
      phoneNumber: phoneNumber
    });
    console.log('Response:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error testing update farmer phone endpoint:', error.response?.data || error.message);
  }
}

// Run tests
async function runTests() {
  console.log('Testing Farmer Phone Correction Endpoints\n');
  
  // Test getting invalid phone farmers
  const invalidFarmers = await testInvalidPhoneFarmers();
  
  // If there are invalid farmers, test updating one
  if (invalidFarmers && invalidFarmers.data && invalidFarmers.data.length > 0) {
    const firstFarmer = invalidFarmers.data[0];
    console.log(`\nTesting update for farmer: ${firstFarmer.name} (ID: ${firstFarmer._id})`);
    await testUpdateFarmerPhone(firstFarmer._id, '9876543210');
  } else {
    console.log('\nNo farmers with invalid phone numbers found to test update endpoint.');
  }
}

runTests(); 