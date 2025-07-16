import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:8000/api/v1';
const AUTH_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2ODY5ZmYwNzllNTJlZmU2MTg0YWVjM2EiLCJwaG9uZU51bWJlciI6NzU4ODY4NjQ1Miwicm9sZSI6IlNVUEVSX0FETUlOIiwibmFtZSI6IlN1cGVyIEFkbWluIiwidHlwZSI6ImFjY2VzcyIsImlhdCI6MTc1MjQwNDExNiwiZXhwIjoxNzUyNDkwNTE2LCJhdWQiOiJudXJzZXJ5LXVzZXJzIiwiaXNzIjoibnVyc2VyeS1hcHAifQ.K78YaX36aFvjdaJUMbJsaB5fCbtBWO4M5Z-Hx8_Tanc';

async function testCascadingAPI(state, district = null, taluka = null, description) {
  console.log(`\n🧪 Testing: ${description}`);
  console.log(`📍 State: ${state}${district ? `, District: ${district}` : ''}${taluka ? `, Taluka: ${taluka}` : ''}`);
  
  const startTime = Date.now();
  
  try {
    const payload = { state };
    if (district) payload.district = district;
    if (taluka) payload.taluka = taluka;
    
    const response = await fetch(`${BASE_URL}/location/cascade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH_TOKEN}`
      },
      body: JSON.stringify(payload)
    });
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    if (response.ok) {
      const data = await response.json();
      const resultCount = data.data?.districts?.length || data.data?.talukas?.length || data.data?.villages?.length || 0;
      const isCached = data.performance?.cached || false;
      
      console.log(`✅ Success: ${duration}ms`);
      console.log(`📊 Response size: ${JSON.stringify(data).length} characters`);
      console.log(`📈 Data count: ${resultCount} items`);
      console.log(`⚡ Cached: ${isCached ? 'Yes' : 'No'}`);
      console.log(`🎯 Performance: ${data.performance?.duration || 'N/A'}`);
      
      return { 
        success: true, 
        duration, 
        size: JSON.stringify(data).length,
        cached: isCached,
        count: resultCount
      };
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

async function runCascadingPerformanceTests() {
  console.log('🚀 Cascading Location API Performance Test');
  console.log('==========================================');
  
  // Test 1: States only (districts)
  const test1 = await testCascadingAPI(
    'Maharashtra',
    null,
    null,
    'Get districts for Maharashtra'
  );
  
  // Test 2: States and districts (talukas)
  const test2 = await testCascadingAPI(
    'Maharashtra',
    'Mumbai',
    null,
    'Get talukas for Maharashtra > Mumbai'
  );
  
  // Test 3: States, districts, and talukas (villages)
  const test3 = await testCascadingAPI(
    'Maharashtra',
    'Mumbai',
    'Mumbai City',
    'Get villages for Maharashtra > Mumbai > Mumbai City'
  );
  
  // Test 4: Repeat test 1 to check caching
  console.log('\n🔄 Testing cache performance...');
  const test4 = await testCascadingAPI(
    'Maharashtra',
    null,
    null,
    'Get districts for Maharashtra (cached)'
  );
  
  // Test 5: Different state
  const test5 = await testCascadingAPI(
    'Karnataka',
    null,
    null,
    'Get districts for Karnataka'
  );
  
  // Summary
  console.log('\n📋 Performance Summary');
  console.log('======================');
  
  const tests = [test1, test2, test3, test4, test5];
  const successfulTests = tests.filter(t => t.success);
  
  if (successfulTests.length > 0) {
    const avgDuration = successfulTests.reduce((sum, t) => sum + t.duration, 0) / successfulTests.length;
    const cachedTests = successfulTests.filter(t => t.cached);
    const cacheHitRate = (cachedTests.length / successfulTests.length * 100).toFixed(1);
    
    console.log(`⏱️  Average response time: ${avgDuration.toFixed(0)}ms`);
    console.log(`📦 Average response size: ${(successfulTests.reduce((sum, t) => sum + t.size, 0) / successfulTests.length).toFixed(0)} characters`);
    console.log(`🎯 Cache hit rate: ${cacheHitRate}%`);
    
    // Compare cached vs non-cached performance
    const nonCachedTests = successfulTests.filter(t => !t.cached);
    if (cachedTests.length > 0 && nonCachedTests.length > 0) {
      const avgCached = cachedTests.reduce((sum, t) => sum + t.duration, 0) / cachedTests.length;
      const avgNonCached = nonCachedTests.reduce((sum, t) => sum + t.duration, 0) / nonCachedTests.length;
      const improvement = ((avgNonCached - avgCached) / avgNonCached * 100).toFixed(1);
      
      console.log(`⚡ Cache performance improvement: ${improvement}% faster`);
    }
  }
  
  console.log('\n🎯 Recommendations:');
  console.log('- Use exact state names for best performance');
  console.log('- Cache will improve subsequent requests');
  console.log('- Monitor cache hit rates for optimization');
}

// Run the tests
runCascadingPerformanceTests().catch(console.error); 