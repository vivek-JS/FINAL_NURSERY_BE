/**
 * Test and Generate Video Script
 * 
 * This script will:
 * 1. Login to get JWT token
 * 2. Call video summary API
 * 3. Generate video using Google TTS + FFmpeg
 */

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';

// Use token from command line or try to login
const TOKEN_FROM_ENV = process.env.JWT_TOKEN;

async function login() {
  // Try multiple login credentials
  const credentials = [
    { phoneNumber: 7588686452, password: 'passsword123443' },
    { phoneNumber: '7588686452', password: 'passsword123443' },
  ];
  
  for (const creds of credentials) {
    try {
      console.log('🔐 Attempting login...\n');
      const response = await axios.post(`${BASE_URL}/api/v1/user/login`, creds);
      
      if (response.data.status === 'Success') {
        const token = response.data.data.accessToken;
        console.log('✅ Login successful!');
        console.log(`   Token: ${token.substring(0, 30)}...\n`);
        return token;
      }
    } catch (error) {
      // Try next credentials
      continue;
    }
  }
  
  throw new Error('Login failed with all credentials. Please provide JWT_TOKEN as environment variable or update credentials in script.');
}

async function generateVideo(token, period = 'day') {
  try {
    console.log(`🎬 Generating video summary (period: ${period})...\n`);
    console.log(`   This may take 20-40 seconds...\n`);
    
    const startTime = Date.now();
    
    const response = await axios.get(`${BASE_URL}/api/v1/inventory/ram-agri-video-summary`, {
      params: { period },
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 120000, // 2 minutes timeout for video generation
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    if (response.data.status === 'Success') {
      const data = response.data.data;
      
      console.log('✅ Video Summary Generated Successfully!\n');
      console.log('═══════════════════════════════════════════════════════');
      console.log('📊 SALES SUMMARY');
      console.log('═══════════════════════════════════════════════════════\n');
      
      console.log(`📅 Period: ${period.toUpperCase()}`);
      console.log(`\n📈 Current Period:`);
      console.log(`   Orders: ${data.currentPeriod.totalOrders}`);
      console.log(`   Dispatched: ${data.currentPeriod.dispatchedOrders}`);
      console.log(`   Sales: ₹${data.currentPeriod.totalSales.toLocaleString('en-IN')}`);
      
      console.log(`\n📉 Previous Period:`);
      console.log(`   Orders: ${data.previousPeriod.totalOrders}`);
      console.log(`   Dispatched: ${data.previousPeriod.dispatchedOrders}`);
      console.log(`   Sales: ₹${data.previousPeriod.totalSales.toLocaleString('en-IN')}`);
      
      console.log(`\n📊 Comparison:`);
      console.log(`   Order Change: ${data.comparison.orderChange > 0 ? '+' : ''}${data.comparison.orderChange} (${data.comparison.orderChangePercent}%)`);
      console.log(`   Sales Change: ₹${data.comparison.salesChange > 0 ? '+' : ''}${data.comparison.salesChange.toLocaleString('en-IN')} (${data.comparison.salesChangePercent}%)`);
      
      if (data.currentPeriod.topSalesman) {
        console.log(`\n🏆 Top Salesman:`);
        console.log(`   Name: ${data.currentPeriod.topSalesman.name}`);
        console.log(`   Sales: ₹${data.currentPeriod.topSalesman.sales.toLocaleString('en-IN')}`);
        console.log(`   Orders: ${data.currentPeriod.topSalesman.orders}`);
      }
      
      console.log(`\n═══════════════════════════════════════════════════════`);
      console.log('📝 HINDI SUMMARY TEXT');
      console.log('═══════════════════════════════════════════════════════\n');
      console.log(data.hindiSummary);
      console.log('\n');
      
      console.log('═══════════════════════════════════════════════════════');
      console.log('🎥 VIDEO GENERATION');
      console.log('═══════════════════════════════════════════════════════\n');
      
      if (data.video?.videoUrl) {
        console.log('✅ Video Generated Successfully!');
        console.log(`   Method: ${data.video.method || 'unknown'}`);
        console.log(`   Duration: ${duration} seconds`);
        console.log(`\n   Video URL: ${data.video.videoUrl}`);
        
        // Construct full URL
        const fullUrl = data.video.videoUrl.startsWith('http') 
          ? data.video.videoUrl 
          : `${BASE_URL}${data.video.videoUrl}`;
        
        console.log(`   Full URL: ${fullUrl}`);
        
        if (data.video.filename) {
          console.log(`   Filename: ${data.video.filename}`);
          console.log(`   Location: temp/videos/${data.video.filename}`);
        }
        
        console.log(`\n   🎬 You can now:`);
        console.log(`      1. Open in browser: ${fullUrl}`);
        console.log(`      2. View from dashboard: Click "Video (${period === 'day' ? 'Day' : 'Week'})" button`);
        console.log(`      3. Download and share the video`);
        
      } else if (data.videoError) {
        console.log('❌ Video Generation Failed:');
        console.log(`   Error: ${data.videoError}`);
      } else {
        console.log('⚠️  Video not generated');
      }
      
      console.log('\n═══════════════════════════════════════════════════════\n');
      console.log('✅ Test completed successfully!\n');
      
      return true;
    } else {
      console.error('❌ API returned error:', response.data.message);
      return false;
    }
  } catch (error) {
    console.error('\n❌ Video generation failed!\n');
    
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Error Data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.error('No response received. Is the server running?');
    } else {
      console.error('Error:', error.message);
    }
    
    return false;
  }
}

// Main execution
async function main() {
  try {
    console.log('═══════════════════════════════════════════════════════');
    console.log('🎬 VIDEO GENERATION TEST');
    console.log('═══════════════════════════════════════════════════════\n');
    
    // Check API key
    if (!process.env.GOOGLE_TTS_API_KEY) {
      console.warn('⚠️  Warning: GOOGLE_TTS_API_KEY not found in .env file');
      console.warn('   Video generation will use D-ID if configured, or fail.\n');
    } else {
      console.log('✅ GOOGLE_TTS_API_KEY found\n');
    }
    
    // Check FFmpeg
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    try {
      await execAsync('ffmpeg -version');
      console.log('✅ FFmpeg is installed\n');
    } catch (e) {
      console.error('❌ FFmpeg not found. Install with: brew install ffmpeg\n');
      process.exit(1);
    }
    
    // Get token
    let token;
    if (TOKEN_FROM_ENV) {
      console.log('✅ Using JWT_TOKEN from environment\n');
      token = TOKEN_FROM_ENV;
    } else {
      token = await login();
    }
    
    // Generate video for day
    console.log('Testing DAY period...\n');
    await generateVideo(token, 'day');
    
    // Wait a bit before next request
    console.log('\n⏳ Waiting 3 seconds before testing WEEK period...\n');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Generate video for week
    console.log('Testing WEEK period...\n');
    await generateVideo(token, 'week');
    
    console.log('\n🎉 All tests completed!\n');
    
  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  }
}

main();
