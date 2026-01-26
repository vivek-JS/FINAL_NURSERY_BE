/**
 * Test D-ID API authentication directly
 * This will help debug authentication issues
 */

import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const D_ID_API_KEY = process.env.D_ID_API_KEY;
const D_ID_API_URL = 'https://api.d-id.com';

if (!D_ID_API_KEY) {
  console.error('❌ D_ID_API_KEY not found in .env file');
  process.exit(1);
}

console.log('🧪 Testing D-ID API Authentication...\n');
console.log('API Key Format:', D_ID_API_KEY.includes(':') ? 'username:password' : 'single key');
console.log('API Key Length:', D_ID_API_KEY.length);
console.log('');

// Test Basic Auth
const authHeader = `Basic ${Buffer.from(D_ID_API_KEY).toString('base64')}`;
console.log('Auth Header (first 50 chars):', authHeader.substring(0, 50) + '...');
console.log('');

// Test 1: Try to list talks (simple endpoint to test auth)
console.log('1️⃣ Testing authentication with GET /talks...');
try {
  const response = await axios.get(`${D_ID_API_URL}/talks`, {
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    },
    params: {
      limit: 1,
    },
  });
  console.log('✅ Authentication successful!');
  console.log('   Status:', response.status);
  console.log('   Response:', JSON.stringify(response.data, null, 2).substring(0, 200));
} catch (error) {
  console.log('❌ Authentication failed!');
  console.log('   Status:', error.response?.status);
  console.log('   Status Text:', error.response?.statusText);
  console.log('   Error Data:', JSON.stringify(error.response?.data, null, 2));
  console.log('');
  console.log('💡 Troubleshooting:');
  console.log('   1. Check if API key is valid at https://studio.d-id.com/');
  console.log('   2. Verify API key format: should be username:password');
  console.log('   3. Check if API key has expired');
  console.log('   4. Verify you have credits/quota available');
}

console.log('');

// Test 2: Try creating a simple talk
console.log('2️⃣ Testing video creation with POST /talks...');
try {
  const talkResponse = await axios.post(
    `${D_ID_API_URL}/talks`,
    {
      source_url: 'https://d-id-public-bucket.s3.amazonaws.com/alice.jpg',
      script: {
        type: 'text',
        input: 'Hello, this is a test.',
        provider: {
          type: 'microsoft',
          voice_id: 'en-US-AriaNeural',
        },
        ssml: false,
      },
      config: {
        stitch: true,
      },
    },
    {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
    }
  );

  console.log('✅ Talk created successfully!');
  console.log('   Talk ID:', talkResponse.data.id);
  console.log('   Status:', talkResponse.data.status);
  console.log('');
  console.log('🎉 Your D-ID API key is working correctly!');
} catch (error) {
  console.log('❌ Talk creation failed!');
  console.log('   Status:', error.response?.status);
  console.log('   Status Text:', error.response?.statusText);
  console.log('   Error Data:', JSON.stringify(error.response?.data, null, 2));
  
  if (error.response?.status === 401 || error.response?.status === 403) {
    console.log('');
    console.log('🔐 Authentication Issue Detected:');
    console.log('   - Your API key might be invalid or expired');
    console.log('   - Please check your API key at https://studio.d-id.com/');
    console.log('   - Make sure the key format is: username:password');
  } else if (error.response?.status === 429) {
    console.log('');
    console.log('⏱️  Rate Limit Issue:');
    console.log('   - You have exceeded the API rate limit');
    console.log('   - Please wait a few minutes and try again');
  }
}

console.log('');
