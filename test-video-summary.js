/**
 * Test script for Ram Agri Video Summary API
 * 
 * Usage:
 * 1. Make sure your server is running
 * 2. Get a valid JWT token from login
 * 3. Run: node test-video-summary.js YOUR_JWT_TOKEN
 */

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';
const API_ENDPOINT = '/api/v1/inventory/ram-agri-video-summary';

async function testVideoSummary(token, period = 'day') {
  try {
    console.log(`\n🧪 Testing Video Summary API (period: ${period})...\n`);
    console.log(`📍 Endpoint: ${BASE_URL}${API_ENDPOINT}?period=${period}`);
    console.log(`🔑 Using token: ${token.substring(0, 20)}...\n`);

    const response = await axios.get(`${BASE_URL}${API_ENDPOINT}`, {
      params: { period },
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000, // 60 seconds timeout
    });

    if (response.data.status === 'Success') {
      const data = response.data.data;
      
      console.log('✅ API Response Success!\n');
      console.log('📊 Summary:');
      console.log(`   Period: ${data.period}`);
      console.log(`   Current Orders: ${data.currentPeriod.totalOrders}`);
      console.log(`   Previous Orders: ${data.previousPeriod.totalOrders}`);
      console.log(`   Order Change: ${data.comparison.orderChange} (${data.comparison.orderChangePercent}%)`);
      console.log(`   Current Sales: ₹${data.currentPeriod.totalSales.toLocaleString('en-IN')}`);
      console.log(`   Previous Sales: ₹${data.previousPeriod.totalSales.toLocaleString('en-IN')}`);
      console.log(`   Sales Change: ₹${data.comparison.salesChange.toLocaleString('en-IN')} (${data.comparison.salesChangePercent}%)`);
      
      if (data.currentPeriod.topSalesman) {
        console.log(`\n🏆 Top Salesman: ${data.currentPeriod.topSalesman.name}`);
        console.log(`   Sales: ₹${data.currentPeriod.topSalesman.sales.toLocaleString('en-IN')}`);
        console.log(`   Orders: ${data.currentPeriod.topSalesman.orders}`);
      }

      console.log(`\n📝 Hindi Summary (first 200 chars):`);
      console.log(`   ${data.hindiSummary.substring(0, 200)}...`);

      if (data.video?.videoUrl) {
        console.log(`\n🎥 Video Generated Successfully!`);
        console.log(`   Video URL: ${data.video.videoUrl}`);
        console.log(`   Talk ID: ${data.video.talkId}`);
      } else if (data.videoError) {
        console.log(`\n⚠️  Video Generation Failed:`);
        console.log(`   Error: ${data.videoError}`);
      } else {
        console.log(`\n⚠️  Video not generated (D_ID_API_KEY may not be configured)`);
      }

      console.log('\n✅ Test completed successfully!\n');
      return true;
    } else {
      console.error('❌ API returned error:', response.data.message);
      return false;
    }
  } catch (error) {
    console.error('\n❌ Test failed!\n');
    
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Error Data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.error('No response received. Is the server running?');
      console.error('Request:', error.request);
    } else {
      console.error('Error:', error.message);
    }
    
    return false;
  }
}

// Get token from command line argument
const token = process.argv[2];
const period = process.argv[3] || 'day';

if (!token) {
  console.error('\n❌ Error: JWT token required\n');
  console.log('Usage: node test-video-summary.js YOUR_JWT_TOKEN [period]\n');
  console.log('Example:');
  console.log('  node test-video-summary.js eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9... day');
  console.log('  node test-video-summary.js eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9... week\n');
  process.exit(1);
}

// Check if D_ID_API_KEY is configured
if (!process.env.D_ID_API_KEY) {
  console.warn('\n⚠️  Warning: D_ID_API_KEY not found in .env file');
  console.warn('   Video generation will be skipped, but text summary will still work.\n');
}

// Run test
testVideoSummary(token, period)
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
