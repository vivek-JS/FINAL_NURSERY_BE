/**
 * Test "मार्गदर्शन सुरू करा" button webhook flow
 *
 * Simulates WATI sending a webhook when user clicks the button.
 * Backend should respond by sending the final_first template.
 *
 * Usage:
 *   node test-guidance-button-webhook.js
 *
 * Or with custom URL:
 *   WEBHOOK_URL=http://localhost:8000/api/v1/whatsapp-order/webhook node test-guidance-button-webhook.js
 *
 * Prerequisites:
 *   1. Backend running (npm run dev)
 *   2. WATI_TOKEN in .env
 *   3. final_first template approved in WATI
 */

// WATI sends message events to opt-in webhook in production – use that URL to test
const WEBHOOK_URL =
  process.env.WEBHOOK_URL || "http://localhost:8000/api/v1/opt-in/webhook";

// Use your phone number to receive the follow-up template (optional - for live test)
const TEST_PHONE = process.env.TEST_PHONE || "919876543210";

async function testGuidanceButtonWebhook() {
  console.log("\n🧪 Testing 'मार्गदर्शन सुरू करा' Button Webhook\n");
  console.log(`   Webhook URL: ${WEBHOOK_URL}`);
  console.log(`   Test phone:  ${TEST_PHONE}`);
  console.log("");

  // Production format (from WATI – opt-in webhook receives this)
  const payloadProd = {
    eventType: "message",
    waId: TEST_PHONE,
    text: "मार्गदर्शन सुरू करा",
    senderName: "vivek",
    buttonReply: {
      payload: '{"ButtonIndex":0,"CarouselCardIndex":null,"BroadcastLinkId":"6999b7b0fe6080096ec60249"}',
      text: "मार्गदर्शन सुरू करा",
    },
  };

  const payloads = [{ name: "Production format (eventType + buttonReply)", body: payloadProd }];

  for (const { name, body } of payloads) {
    console.log(`📤 Sending ${name}...`);
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Wati-webhook/1.0",
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      console.log(`   Status: ${res.status}`);
      console.log(`   Response: ${text.substring(0, 200)}`);
      if (res.ok) {
        console.log(`   ✅ Webhook accepted\n`);
      } else {
        console.log(`   ❌ Webhook failed\n`);
      }
    } catch (err) {
      console.error(`   ❌ Error: ${err.message}\n`);
    }
  }

  console.log("📋 Next steps:");
  console.log("   1. Check backend logs for: [GUIDANCE] User clicked...");
  console.log("   2. If TEST_PHONE is your WhatsApp number, you should receive the final_first template");
  console.log("   3. For DB fallback test: use a phone that exists in Farmer/FarmerLead but omit senderName\n");
}

testGuidanceButtonWebhook();
