import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const WATI_URL = "https://live-mt-server.wati.io/385403";
const WATI_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIwNjY4YWY5Zi1jN2I1LTQ2N2QtOWU0Yi01ZjRjOTJhNThlZjMiLCJ1bmlxdWVfbmFtZSI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwibmFtZWlkIjoidml2ZWtjLmFwa0BnbWFpbC5jb20iLCJlbWFpbCI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwiYXV0aF90aW1lIjoiMDkvMjEvMjAyNSAwNDo1ODozMiIsInRlbmFudF9pZCI6IjM4NTQwMyIsImRiX25hbWUiOiJtdC1wcm9kLVRlbmFudHMiLCJodHRwOi8vc2NoZW1hcy5taWNyb3NvZnQuY29tL3dzLzIwMDgvMDYvaWRlbnRpdHkvY2xhaW1zL3JvbGUiOiJBRE1JTklTVFJBVE9SIiwiZXhwIjoyNTM0MDIzMDA4MDAsImlzcyI6IkNsYXJlX0FJIiwiYXVkIjoiQ2xhcmVfQUkifQ.zAP3ZxQXUO1NWJGLe0e39qVeiXLK_d8U2y0bonMjomw";
const PHONE = "917588686453";

// All possible field name variations to test
const testFormats = [
  { name: "text", payload: { text: "Test message" } },
  { name: "messageText", payload: { messageText: "Test message" } },
  { name: "message", payload: { message: "Test message" } },
  { name: "body", payload: { body: "Test message" } },
  { name: "content", payload: { content: "Test message" } },
  { name: "msg", payload: { msg: "Test message" } },
  { name: "text (nested)", payload: { text: { body: "Test message" } } },
  { name: "message (nested)", payload: { message: { text: "Test message" } } },
  { name: "empty object", payload: {} },
  { name: "no body", payload: null },
];

async function testAllFormats() {
  console.log("\n🧪 Testing ALL possible WATI sendSessionMessage formats...\n");
  console.log(`📍 URL: ${WATI_URL}/api/v1/sendSessionMessage/${PHONE}`);
  console.log(`📱 Phone: ${PHONE}\n`);

  for (const format of testFormats) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing: ${format.name}`);
    console.log(`Payload: ${JSON.stringify(format.payload)}`);
    console.log(`${'='.repeat(60)}`);

    try {
      const options = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": `Bearer ${WATI_TOKEN}`,
        },
      };

      if (format.payload !== null) {
        options.body = JSON.stringify(format.payload);
      }

      const res = await fetch(
        `${WATI_URL}/api/v1/sendSessionMessage/${PHONE}`,
        options
      );

      const responseText = await res.text();
      let data = {};
      
      try {
        data = responseText ? JSON.parse(responseText) : {};
      } catch (e) {
        data = { raw: responseText };
      }

      console.log(`Status: ${res.status}`);
      console.log(`Response: ${JSON.stringify(data, null, 2)}`);

      if (res.ok && data.result !== false && !data.info?.includes("empty")) {
        console.log("✅✅✅ SUCCESS! This format works! ✅✅✅");
        return; // Exit on first success
      }
    } catch (err) {
      console.error(`❌ Error: ${err.message}`);
    }

    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log("\n⚠️  None of the formats worked.");
  console.log("\n💡 Possible issues:");
  console.log("   1. Phone number needs active session (user must message WATI first)");
  console.log("   2. API endpoint or format might be different");
  console.log("   3. Check WATI API documentation for correct format");
}

testAllFormats();


