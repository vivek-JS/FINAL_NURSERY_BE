import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const WATI_URL = process.env.WATI_URL;
const WATI_TOKEN = process.env.WATI_TOKEN;
const PHONE = "917588686453";

async function sendTestMessage() {
  try {
    console.log("\n🧪 Testing WATI Session Message...\n");
    
    if (!WATI_URL || !WATI_TOKEN) {
      console.error("❌ ERROR: WATI_URL or WATI_TOKEN not set");
      return;
    }

    const url = `${WATI_URL}/api/v1/sendSessionMessage/${PHONE}`;
    
    // Handle token - remove "Bearer " if already present
    const authToken = WATI_TOKEN.startsWith("Bearer ") 
      ? WATI_TOKEN 
      : `Bearer ${WATI_TOKEN}`;

    console.log(`📤 URL: ${url}`);
    console.log(`📱 Phone: ${PHONE}`);
    console.log(`📝 Message: "✅ Local test successful! WATI session message works."\n`);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({
        text: "✅ Local test successful! WATI session message works.",
      }),
    });

    const responseText = await res.text();
    let data = {};
    
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch (e) {
      data = { raw: responseText };
    }

    console.log(`📊 Status: ${res.status} ${res.statusText}`);
    console.log("📦 Response:", JSON.stringify(data, null, 2));
    
    if (res.ok && data.result !== false) {
      console.log("\n✅ SUCCESS! Message sent!");
      console.log("📱 Check WhatsApp on", PHONE);
    } else {
      console.log("\n⚠️  Response indicates failure.");
      if (data.info?.includes("empty")) {
        console.log("\n💡 TIP: The phone number must have an ACTIVE SESSION.");
        console.log("   This means the user must have messaged your WATI number first.");
        console.log("   Try sending a message FROM", PHONE, "TO your WATI number first.");
      }
    }
  } catch (err) {
    console.error("❌ ERROR:", err.message);
  }
}

sendTestMessage();


