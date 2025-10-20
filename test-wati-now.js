import fetch from "node-fetch";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

/**
 * Quick WATI Test - Send message to 7588686453
 * 
 * INSTRUCTIONS:
 * 1. Update TEMPLATE_NAME below with your template name
 * 2. Run: cd FINAL_NURSERY_BE && node test-wati-now.js
 */

// ============ UPDATE THIS WITH YOUR TEMPLATE NAME ============
const TEMPLATE_NAME = "order_accepted"; // Change this to your actual template name
// ==============================================================

async function quickTest() {
  console.log("\n" + "=".repeat(70));
  console.log("📱 Quick WATI WhatsApp Test to 7588686453");
  console.log("=".repeat(70) + "\n");

  const phoneNumber = "7588686453";
  const WATI_TOKEN = process.env.WATI_TOKEN;
  const WATI_URL = "https://live-mt-server.wati.io/385403/api/v1/sendTemplateMessage";

  if (!WATI_TOKEN) {
    console.error("❌ WATI_TOKEN not found in .env file!");
    return;
  }

  console.log("✅ WATI Token: Found");
  console.log(`📞 Phone Number: 91${phoneNumber}`);
  console.log(`📋 Template Name: ${TEMPLATE_NAME}`);
  console.log("");

  // Example parameters - adjust based on your template
  const parameters = [
    { name: "1", value: "Vivek Chaudhari" },        // Parameter 1
    { name: "2", value: "TEST-123" },               // Parameter 2
    { name: "3", value: "Banana Plants" },          // Parameter 3
    { name: "4", value: "1000" },                   // Parameter 4
    { name: "5", value: "25/10/2025" },             // Parameter 5
    { name: "6", value: "₹12,000" },                // Parameter 6
  ];

  const body = {
    template_name: TEMPLATE_NAME,
    broadcast_name: `QuickTest_${Date.now()}`,
    parameters: parameters,
  };

  console.log("📤 Sending WhatsApp message via WATI...\n");
  console.log("Request Body:", JSON.stringify(body, null, 2));
  console.log("");

  try {
    const startTime = Date.now();
    
    const response = await fetch(
      `${WATI_URL}?whatsappNumber=91${phoneNumber}`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
          Authorization: WATI_TOKEN,
        },
      }
    );

    const endTime = Date.now();
    
    console.log(`⏱️  Response Time: ${endTime - startTime}ms`);
    console.log(`📊 HTTP Status: ${response.status} ${response.statusText}`);
    console.log("");

    // Get response text first
    const responseText = await response.text();
    console.log("📦 Raw Response:");
    console.log(responseText);
    console.log("");

    // Try to parse as JSON
    let data;
    try {
      data = responseText ? JSON.parse(responseText) : {};
      console.log("📦 Parsed Response Data:");
      console.log(JSON.stringify(data, null, 2));
      console.log("");
    } catch (e) {
      console.log("⚠️  Response is not valid JSON");
      data = { raw: responseText };
    }

    if (response.ok) {
      console.log("✅ ✅ ✅ SUCCESS! ✅ ✅ ✅");
      console.log("");
      console.log("🎉 WhatsApp message sent successfully!");
      console.log(`📱 Check WhatsApp on +91 ${phoneNumber}`);
      console.log("⏰ Message should arrive within 1-2 minutes");
      console.log("");
    } else {
      console.log("❌ ❌ ❌ FAILED! ❌ ❌ ❌");
      console.log("");
      console.log("🔍 Troubleshooting Guide:");
      console.log("");
      console.log("1. Template Not Approved:");
      console.log("   → Go to https://app.wati.io/");
      console.log("   → Check if template is APPROVED by WhatsApp");
      console.log("");
      console.log("2. Wrong Template Name:");
      console.log(`   → Current: "${TEMPLATE_NAME}"`);
      console.log("   → Check exact name in WATI dashboard");
      console.log("   → Names are case-sensitive!");
      console.log("");
      console.log("3. Phone Number Issues:");
      console.log(`   → Number: +91 ${phoneNumber}`);
      console.log("   → Check if number has WhatsApp installed");
      console.log("   → Try with a different number");
      console.log("");
      console.log("4. WATI Credits:");
      console.log("   → Check if you have credits in WATI account");
      console.log("   → Go to Settings → Billing");
      console.log("");
      console.log("5. Token Issue:");
      console.log("   → Token might be expired");
      console.log("   → Generate new token from WATI dashboard");
      console.log("");
    }
  } catch (error) {
    console.error("❌ NETWORK ERROR:", error.message);
    console.log("");
    console.log("🔍 Error Details:");
    console.log(error);
    console.log("");
  }

  console.log("=".repeat(70) + "\n");
}

// Run the test
quickTest().catch(console.error);

