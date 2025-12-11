import fetch from 'node-fetch';

const WEBHOOK_URL = 'http://localhost:8000/api/v1/whatsapp-order/webhook';
const TEST_MOBILE = '919876543210';

async function testPostHandler() {
  console.log('🧪 Testing POST Handler Functionality...\n');
  console.log(`📍 Webhook URL: ${WEBHOOK_URL}`);
  console.log(`📱 Test Mobile: ${TEST_MOBILE}\n`);

  console.log('='.repeat(60));
  console.log('Test: Sending ORDER message');
  console.log('='.repeat(60));

  try {
    const payload = {
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

    console.log('\n📤 Sending payload:');
    console.log(JSON.stringify(payload, null, 2));

    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    
    console.log('\n📥 Response:');
    console.log(`Status: ${response.status}`);
    console.log(JSON.stringify(result, null, 2));

    if (response.ok && result.success) {
      console.log('\n✅ POST Handler is working!');
      console.log('✅ Webhook received and processed');
      console.log('\n📋 Check your server logs for:');
      console.log('   - "📥 Webhook Received"');
      console.log('   - "✅ Processing order flow"');
      console.log('   - "✅ Step: welcome"');
      console.log('\n💡 Note: If WATI_TOKEN is not set, message sending will fail');
      console.log('   but the handler itself is working correctly.');
    } else {
      console.log('\n❌ POST Handler returned error');
    }
  } catch (error) {
    console.error('\n❌ Request failed:', error.message);
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ Test completed!');
  console.log('='.repeat(60));
}

testPostHandler().catch(console.error);

