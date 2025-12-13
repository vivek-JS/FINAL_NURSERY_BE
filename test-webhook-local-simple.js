import fetch from 'node-fetch';

/**
 * Simple Local Webhook Test Script
 * 
 * USAGE:
 * 1. Make sure your server is running: npm run dev (or npm start)
 * 2. Run this script: node test-webhook-local-simple.js
 */

const WEBHOOK_URL = 'http://localhost:8000/api/v1/whatsapp-order/webhook';
const TEST_MOBILE = '919876543210';

console.log('\n🧪 Testing WhatsApp Webhook Locally...\n');
console.log(`📍 Webhook URL: ${WEBHOOK_URL}`);
console.log(`📱 Test Mobile: ${TEST_MOBILE}\n`);
console.log('⚠️  Make sure your server is running on port 8000!');
console.log('   Run: cd FINAL_NURSERY_BE && npm run dev\n');

// Test payload - simulates Wati webhook
const testPayload = {
  event: 'message',
  data: {
    waId: TEST_MOBILE,
    text: {
      body: 'ORDER'
    },
    from: TEST_MOBILE,
    timestamp: Date.now().toString()
  }
};

async function testWebhook() {
  try {
    console.log('📤 Sending test webhook...\n');
    console.log('📦 Payload:');
    console.log(JSON.stringify(testPayload, null, 2));
    console.log('\n');

    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(testPayload),
    });

    const result = await response.json();
    
    console.log(`📊 HTTP Status: ${response.status}`);
    console.log('📦 Response:');
    console.log(JSON.stringify(result, null, 2));
    console.log('\n');

    if (response.ok) {
      console.log('✅ SUCCESS! Webhook received and processed!\n');
      console.log('📋 Check your server console for detailed logs:');
      console.log('   - 🌐🌐🌐 INCOMING REQUEST TO WEBHOOK');
      console.log('   - ✅✅✅ WEBHOOK ROUTE HIT');
      console.log('   - 🔥🔥 RAW WATI WEBHOOK RECEIVED\n');
    } else {
      console.log('❌ FAILED! Check server logs for errors.\n');
    }
  } catch (error) {
    console.error('❌ ERROR:', error.message);
    console.log('\n💡 Make sure:');
    console.log('   1. Server is running: npm run dev');
    console.log('   2. Server is on port 8000');
    console.log('   3. MongoDB is connected\n');
  }
}

// Run test
testWebhook();

