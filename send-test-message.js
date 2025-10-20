import fetch from "node-fetch";

/**
 * Send Test WhatsApp Message to 7588686453
 * Using template: order_accpeted_revamped
 */

const WATI_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIwNjY4YWY5Zi1jN2I1LTQ2N2QtOWU0Yi01ZjRjOTJhNThlZjMiLCJ1bmlxdWVfbmFtZSI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwibmFtZWlkIjoidml2ZWtjLmFwa0BnbWFpbC5jb20iLCJlbWFpbCI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwiYXV0aF90aW1lIjoiMDkvMjEvMjAyNSAwNDo1ODozMiIsInRlbmFudF9pZCI6IjM4NTQwMyIsImRiX25hbWUiOiJtdC1wcm9kLVRlbmFudHMiLCJodHRwOi8vc2NoZW1hcy5taWNyb3NvZnQuY29tL3dzLzIwMDgvMDYvaWRlbnRpdHkvY2xhaW1zL3JvbGUiOiJBRE1JTklTVFJBVE9SIiwiZXhwIjoyNTM0MDIzMDA4MDAsImlzcyI6IkNsYXJlX0FJIiwiYXVkIjoiQ2xhcmVfQUkifQ.zAP3ZxQXUO1NWJGLe0e39qVeiXLK_d8U2y0bonMjomw";

const TEMPLATE_NAME = "order_accpeted_revamped";
const PHONE_NUMBER = "7588686452";

async function sendTestMessage() {
  console.log("\n" + "=".repeat(80));
  console.log("📱 Sending WhatsApp Test Message");
  console.log("=".repeat(80) + "\n");

  const parameters = [
    { name: "name", value: "Vivek Chaudhari" },
    { name: "id", value: "TEST-123" },
    { name: "village", value: "Jalgaon" },
    { name: "number", value: "7588686453" },
    { name: "plant", value: "Banana" },
    { name: "subtype", value: "G-916" },
    { name: "total_booked", value: "1000" },
    { name: "rate", value: "12" },
    { name: "total", value: "12000" },
    { name: "advacne", value: "5000" },    // Note: typo in template "advacne"
    { name: "remaiing", value: "7000" },   // Note: typo in template "remaiing"
    { name: "delivery", value: "25/10/2025" }
  ];

  const body = {
    template_name: TEMPLATE_NAME,
    broadcast_name: `Test_${Date.now()}`,
    parameters: parameters
  };

  console.log("✅ Configuration:");
  console.log(`   📱 To: +91 ${PHONE_NUMBER}`);
  console.log(`   📋 Template: ${TEMPLATE_NAME}`);
  console.log(`   🔑 Token: ${WATI_TOKEN.substring(0, 40)}...`);
  console.log("");
  console.log("📤 Request Body:");
  console.log(JSON.stringify(body, null, 2));
  console.log("");
  console.log("⏳ Sending message...\n");

  try {
    const response = await fetch(
      `https://live-mt-server.wati.io/385403/api/v1/sendTemplateMessage?whatsappNumber=91${PHONE_NUMBER}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": WATI_TOKEN,
          "Accept": "application/json"
        },
        body: JSON.stringify(body)
      }
    );

    const responseText = await response.text();
    
    console.log(`📊 Status: ${response.status} ${response.statusText}`);
    console.log(`📦 Response: ${responseText || '(empty)'}`);
    console.log("");

    if (response.ok) {
      console.log("🎉 🎉 🎉 SUCCESS! 🎉 🎉 🎉");
      console.log("");
      console.log("✅ WhatsApp message sent successfully!");
      console.log(`📱 Check WhatsApp on +91 ${PHONE_NUMBER}`);
      console.log("⏰ Message should arrive in 1-2 minutes");
      console.log("");
      console.log("Message Preview:");
      console.log("─────────────────────────────────────");
      console.log("👋 नमस्कार Vivek Chaudhari");
      console.log("आपली ऑर्डर स्वीकारली आहे!");
      console.log("");
      console.log("📝 ऑर्डर तपशील:");
      console.log("🆔 ऑर्डर आयडी: TEST-123");
      console.log("🏡 गाव: Jalgaon");
      console.log("🌱 रोप प्रकार: Banana");
      console.log("🔖 उप-प्रकार: G-916");
      console.log("🌿 एकूण रोपे: 1000");
      console.log("");
      console.log("💰 पेमेंट तपशील:");
      console.log("प्रति रोप दर: ₹12");
      console.log("एकूण रक्कम: ₹12000");
      console.log("प्राप्त रक्कम: ₹5000");
      console.log("शिल्लक रक्कम: ₹7000");
      console.log("");
      console.log("🚚 डिलिव्हरी तारीख: 25/10/2025");
      console.log("─────────────────────────────────────");
    } else {
      console.log("❌ FAILED!");
      console.log("");
      console.log("🔍 Possible issues:");
      console.log("  1. Template not approved in WATI");
      console.log("  2. Phone number not on WhatsApp");
      console.log("  3. WATI credits exhausted");
      console.log("  4. Wrong template name");
      console.log("");
      console.log("💡 Check WATI Dashboard: https://app.wati.io/");
    }
  } catch (error) {
    console.error("❌ ERROR:", error.message);
  }

  console.log("\n" + "=".repeat(80) + "\n");
}

sendTestMessage();

