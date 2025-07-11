// Test script to verify browser can access login response data
import fetch from 'node-fetch';

async function testBrowserAccess() {
  console.log('🧪 Testing browser access to login endpoint...\n');
  
  try {
    const response = await fetch('http://localhost:8000/api/v1/user/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'http://localhost:3001' // Simulate frontend origin
      },
      body: JSON.stringify({
        phoneNumber: 7588686452,
        password: "passsword123443"
      })
    });
    
    console.log('📊 Response Status:', response.status);
    console.log('📋 Response Headers:');
    
    // Check for problematic headers
    const headers = response.headers.raw();
    let hasCOOP = false;
    let hasCSP = false;
    
    for (const [key, value] of Object.entries(headers)) {
      console.log(`  ${key}: ${value.join(', ')}`);
      if (key.toLowerCase() === 'cross-origin-opener-policy') {
        hasCOOP = true;
      }
      if (key.toLowerCase() === 'content-security-policy') {
        hasCSP = true;
      }
    }
    
    console.log('\n🔍 Header Analysis:');
    if (hasCOOP) {
      console.log('  ❌ COOP header found - this will block browser access');
    } else {
      console.log('  ✅ No COOP header - browser access should work');
    }
    
    if (hasCSP) {
      console.log('  ⚠️  CSP header found - check if it allows your origin');
    } else {
      console.log('  ✅ No CSP header - no restrictions');
    }
    
    console.log('\n📄 Response Body:');
    const data = await response.text();
    console.log(data);
    
    // Try to parse as JSON
    try {
      const jsonData = JSON.parse(data);
      console.log('\n✅ Successfully parsed JSON response');
      console.log('📦 Access Token:', jsonData.data?.accessToken ? '✅ Present' : '❌ Missing');
      console.log('📦 Refresh Token:', jsonData.data?.refreshToken ? '✅ Present' : '❌ Missing');
      console.log('👤 User Data:', jsonData.data?.user ? '✅ Present' : '❌ Missing');
    } catch (parseError) {
      console.log('\n❌ Failed to parse JSON response:', parseError.message);
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Run the test
testBrowserAccess(); 