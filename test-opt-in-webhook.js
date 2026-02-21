/**
 * Test opt-in webhook with the exact Wati payload format
 * Usage: node test-opt-in-webhook.js
 * Or: WEBHOOK_URL=https://your-server.com/api/v1/opt-in/webhook node test-opt-in-webhook.js
 */
import fetch from "node-fetch";

const WEBHOOK_URL =
  process.env.WEBHOOK_URL || "http://localhost:8000/api/v1/opt-in/webhook";

// Exact payload from Wati message webhook (Format 2)
const payload = {
  id: "699994244c2ab0143bdfb0fd",
  created: "2026-02-21T11:16:51.9575237Z",
  whatsappMessageId: "wamid.HBgMOTE3NTg4Njg2NDUyFQIAEhgUMkE5MkZCNjQyRjIyQTUwNEFGOEYA",
  conversationId: "676d0b0c6f084def30067b14",
  ticketId: "699994244c2ab0143bdfb0f9",
  text: "मार्गदर्शन सुरू करा",
  type: "button",
  data: null,
  sourceId: null,
  sourceUrl: null,
  timestamp: "1771672610",
  owner: false,
  eventType: "message",
  statusString: "SENT",
  avatarUrl: null,
  assignedId: null,
  operatorName: null,
  operatorEmail: null,
  waId: "917588686452",
  messageContact: null,
  senderName: "Ram Biotech",
  listReply: null,
  interactiveButtonReply: null,
  buttonReply: {
    payload:
      '{"ButtonIndex":0,"CarouselCardIndex":null,"BroadcastLinkId":"699993ad235d0fb7f56871ca"}',
    text: "मार्गदर्शन सुरू करा",
  },
  replyContextId:
    "wamid.HBgMOTE3NTg4Njg2NDUyFQIAERgSMjM0QUQxRjQyOTRGMTI2MENEAA==",
  sourceType: 7,
  frequentlyForwarded: false,
  forwarded: false,
};

async function testOptInWebhook() {
  console.log("🧪 Testing Opt-In Webhook...\n");
  console.log(`📍 URL: ${WEBHOOK_URL}`);
  console.log(`📱 waId: ${payload.waId}`);
  console.log(`👤 senderName: ${payload.senderName}`);
  console.log(`📅 timestamp: ${payload.timestamp}`);
  console.log(`📋 eventType: ${payload.eventType}\n`);

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Wati-webhook/1.0",
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    console.log(`Status: ${response.status}`);
    console.log("Response:", JSON.stringify(result, null, 2));

    if (response.ok && result.success) {
      console.log("\n✅ Opt-in webhook test passed!");
    } else {
      console.log("\n❌ Opt-in webhook test failed");
    }
  } catch (error) {
    console.error("❌ Request failed:", error.message);
  }
}

testOptInWebhook().catch(console.error);
