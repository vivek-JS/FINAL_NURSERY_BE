import fetch from "node-fetch";

/**
 * Simple WATI Test Script
 * 
 * USAGE:
 * 1. Update WATI_TOKEN and TEMPLATE_NAME below
 * 2. Run: node test-wati-simple.js
 */

// ============ CONFIGURATION - UPDATE THESE ============

const WATI_TOKEN = "YOUR_WATI_TOKEN_HERE"; // Your WATI token
const TEMPLATE_NAME = "YOUR_TEMPLATE_NAME"; // Your template name (e.g., "order_accepted")
const PHONE_NUMBER = "7588686453"; // Phone number to test

// Template parameters - adjust based on your template
const TEMPLATE_PARAMETERS = [
  { name: "name", value: "Vivek Chaudhari" },
  { name: "orderNumber", value: "TEST-123" },
  // Add more parameters as needed for your template
];

// =====================================================

async function sendTestMessage() {
  console.log("\n" + "=".repeat(60));
  console.log("🧪 WATI WhatsApp Test");
  console.log("=".repeat(60) + "\n");

  // Validation
  if (WATI_TOKEN === "YOUR_WATI_TOKEN_HERE") {
    console.error("❌ ERROR: Please update WATI_TOKEN in the script!");
    console.log("\n📝 Steps:");
    console.log("1. Open test-wati-simple.js");
    console.log("2. Replace YOUR_WATI_TOKEN_HERE with your actual token");
    console.log("3. Replace YOUR_TEMPLATE_NAME with your template name");
    console.log("4. Run the script again\n");
    return;
  }

  if (TEMPLATE_NAME === "YOUR_TEMPLATE_NAME") {
    console.error("❌ ERROR: Please update TEMPLATE_NAME in the script!");
    return;
  }

  console.log("📋 Configuration:");
  console.log(`   Phone: 91${PHONE_NUMBER}`);
  console.log(`   Template: ${TEMPLATE_NAME}`);
  console.log(`   Token: ${WATI_TOKEN.substring(0, 30)}...`);
  console.log(`   Parameters: ${JSON.stringify(TEMPLATE_PARAMETERS, null, 2)}`);
  console.log("");

  const WATI_URL = "https://live-mt-server.wati.io/385403/api/v1/sendTemplateMessage";

  const body = {
    template_name: TEMPLATE_NAME,
    broadcast_name: `Test_${Date.now()}`,
    parameters: TEMPLATE_PARAMETERS,
  };

  console.log("📤 Sending message to WATI...\n");

  try {
    const response = await fetch(
      `${WATI_URL}?whatsappNumber=91${PHONE_NUMBER}`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
          Authorization: WATI_TOKEN,
        },
      }
    );

    const data = await response.json();

    console.log(`📊 HTTP Status: ${response.status}`);
    console.log(`📦 Response:\n${JSON.stringify(data, null, 2)}\n`);

    if (response.ok) {
      console.log("✅ SUCCESS! Message sent! 🎉");
      console.log(`✅ Check WhatsApp on 91${PHONE_NUMBER}\n`);
    } else {
      console.error("❌ FAILED!");
      console.log("\n🔍 Possible reasons:");
      console.log("   • Template not approved in WATI");
      console.log("   • Wrong template name");
      console.log("   • Phone not on WhatsApp");
      console.log("   • Invalid token");
      console.log("   • No WATI credits\n");
      console.log("💡 Check: https://app.wati.io/\n");
    }
  } catch (error) {
    console.error("❌ ERROR:", error.message, "\n");
  }

  console.log("=".repeat(60) + "\n");
}

sendTestMessage();



