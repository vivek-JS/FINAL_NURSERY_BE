import fetch from 'node-fetch';

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:8000/api/v1/whatsapp-order/webhook';
const TEST_MOBILE = process.env.TEST_MOBILE || '919876543210';

async function testWebhook() {
  console.log('🧪 Testing WhatsApp Webhook Locally...\n');
  console.log(`📍 Webhook URL: ${WEBHOOK_URL}`);
  console.log(`📱 Test Mobile: ${TEST_MOBILE}\n`);

  const testPayloads = [
    {
      name: 'Test 1: Welcome Message (ORDER)',
      payload: {
        event: 'message',
        data: {
          waId: TEST_MOBILE,
          text: {
            body: 'ORDER'
          },
          from: TEST_MOBILE,
          timestamp: Date.now().toString()
        }
      }
    },
    {
      name: 'Test 2: Mobile Number Entry',
      payload: {
        event: 'message',
        data: {
          waId: TEST_MOBILE,
          text: {
            body: '9876543210'
          },
          from: TEST_MOBILE
        }
      }
    },
    {
      name: 'Test 3: Farmer Name Entry',
      payload: {
        event: 'message',
        data: {
          waId: TEST_MOBILE,
          text: {
            body: 'John Doe'
          },
          from: TEST_MOBILE
        }
      }
    }
  ];

  for (const test of testPayloads) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🧪 ${test.name}`);
    console.log(`${'='.repeat(50)}`);

    try {
      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(test.payload),
      });

      const result = await response.json();
      
      if (response.ok) {
        console.log('✅ Success!');
        console.log('Response:', JSON.stringify(result, null, 2));
      } else {
        console.log('❌ Error:', response.status);
        console.log('Response:', JSON.stringify(result, null, 2));
      }
    } catch (error) {
      console.error('❌ Request failed:', error.message);
    }

    // Wait 2 seconds between tests
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log('\n✅ All tests completed!');
}

// Run tests
testWebhook().catch(console.error);


