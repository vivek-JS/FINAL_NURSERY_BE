import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const WATI_URL = process.env.WATI_URL;
const WATI_TOKEN = process.env.WATI_TOKEN;

// ⚠️ IMPORTANT
// This must be YOUR personal WhatsApp number that already messaged the WATI number
const PHONE = "917588686453"; // <-- replace if neededf

async function sendTestMessage() {
  try {
    console.log("\n🧪 Testing WATI Session Message...\n");
    console.log(`📍 WATI URL: ${WATI_URL}`);
    console.log(`📱 Phone: ${PHONE}`);
    console.log(`🔑 Token: ${WATI_TOKEN ? WATI_TOKEN.substring(0, 20) + '...' : 'NOT SET'}\n`);

    if (!WATI_URL || !WATI_TOKEN) {
      console.error("❌ ERROR: WATI_URL or WATI_TOKEN not set in environment variables");
      return;
    }

    const url = `${WATI_URL}/api/v1/sendSessionMessage/${PHONE}`;
    console.log(`📤 Sending to: ${url}\n`);

    // Handle token - remove "Bearer " if already present
    const authToken = WATI_TOKEN.startsWith("Bearer ") 
      ? WATI_TOKEN 
      : `Bearer ${WATI_TOKEN}`;

    // WATI sendSessionMessage API format - check documentation
    // Common formats to try:
    const testPayloads = [
      { text: "✅ Test with 'text' field" },
      { messageText: "✅ Test with 'messageText' field" },
      { message: "✅ Test with 'message' field" },
      { body: "✅ Test with 'body' field" },
    ];

    for (const payload of testPayloads) {
      console.log(`\n🧪 Trying payload: ${JSON.stringify(payload)}`);
      
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          Authorization: authToken,
        },
        body: JSON.stringify(payload),
      });

      console.log(`📊 HTTP Status: ${res.status} ${res.statusText}`);
      
      const responseText = await res.text();
      console.log(`📦 Raw Response: ${responseText || '(empty)'}`);

      let data;
      try {
        data = responseText ? JSON.parse(responseText) : {};
      } catch (e) {
        data = { raw: responseText };
      }

      console.log("📤 WATI RESPONSE:", JSON.stringify(data, null, 2));
      
      if (res.ok && data.result !== false) {
        console.log("\n✅ SUCCESS! Message sent successfully!");
        console.log("📱 Check your WhatsApp for the message!");
        return; // Exit on first success
      } else {
        console.log("❌ This format didn't work, trying next...\n");
      }
    }
    
    console.log("\n⚠️  All formats failed. Check WATI API documentation.");
    return;

    console.log(`📊 HTTP Status: ${res.status} ${res.statusText}`);
    
    // Get response text first
    const responseText = await res.text();
    console.log(`📦 Raw Response: ${responseText || '(empty)'}\n`);

    // Try to parse as JSON
    let data;
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch (e) {
      console.log("⚠️  Response is not JSON, showing raw text above");
      data = { raw: responseText };
    }

    console.log("📤 WATI RESPONSE:", JSON.stringify(data, null, 2));
    
    if (res.ok) {
      console.log("\n✅ SUCCESS! Message sent successfully!");
      console.log("📱 Check your WhatsApp for the message!");
    } else {
      console.log("\n❌ FAILED! Check the response above for errors.");
    }
  } catch (err) {
    console.error("❌ ERROR:", err.message);
  }
}

sendTestMessage();

