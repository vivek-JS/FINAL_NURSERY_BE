import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:8000/api/v1';

async function testEndpoint(endpoint, description) {
  console.log(`\n🧪 Testing: ${description}`);
  console.log(`📍 Endpoint: ${endpoint}`);
  
  const startTime = Date.now();
  
  try {
    const response = await fetch(endpoint);
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    if (response.ok) {
      const data = await response.json();
      console.log(`✅ Success: ${duration}ms`);
      console.log(`📊 Response size: ${JSON.stringify(data).length} characters`);
      console.log(`📈 Data count: ${data.data?.length || 'N/A'} items`);
      return { success: true, duration, size: JSON.stringify(data).length };
    } else {
      console.log(`❌ Failed: ${response.status} - ${response.statusText}`);
      return { success: false, duration };
    }
  } catch (error) {
    const endTime = Date.now();
    const duration = endTime - startTime;
    console.log(`❌ Error: ${error.message} (${duration}ms)`);
    return { success: false, duration };
  }
}

async function runPerformanceTests() {
  console.log('🚀 Location API Performance Test');
  console.log('================================');
  
  // Test the old endpoint (all location data)
  const oldResult = await testEndpoint(
    `${BASE_URL}/location/all`,
    'Old endpoint - All location data'
  );
  
  // Test the new optimized endpoint (states only)
  const newResult = await testEndpoint(
    `${BASE_URL}/location/states-only`,
    'New optimized endpoint - States only'
  );
  
  // Test the cascading endpoint
  const cascadeResult = await testEndpoint(
    `${BASE_URL}/location/cascade`,
    'Cascading endpoint - Districts for a state'
  );
  
  // Summary
  console.log('\n📋 Performance Summary');
  console.log('======================');
  
  if (oldResult.success && newResult.success) {
    const improvement = ((oldResult.duration - newResult.duration) / oldResult.duration * 100).toFixed(1);
    const sizeReduction = ((oldResult.size - newResult.size) / oldResult.size * 100).toFixed(1);
    
    console.log(`⏱️  Response time improvement: ${improvement}% faster`);
    console.log(`📦 Data size reduction: ${sizeReduction}% smaller`);
    console.log(`⚡ Speed improvement: ${oldResult.duration / newResult.duration}x faster`);
  }
  
  console.log('\n🎯 Recommendations:');
  console.log('- Use /location/states-only for initial state dropdown');
  console.log('- Use /location/cascade for subsequent location selections');
  console.log('- Avoid /location/all unless you need complete data');
}

// Run the tests
runPerformanceTests().catch(console.error); 