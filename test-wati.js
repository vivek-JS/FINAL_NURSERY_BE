import fetch from "node-fetch";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

/**
 * Test WATI WhatsApp messaging
 */
async function testWatiMessage() {
  console.log("\n🧪 Testing WATI WhatsApp Integration...\n");

  // Configuration
  const phoneNumber = "7588686453";
  const WATI_URL = process.env.SEND_TEMPLATE_MESSAGE_URL || "https://live-mt-server.wati.io/385403/api/v1/sendTemplateMessage";
  const WATI_TOKEN = process.env.WATI_TOKEN;

  console.log("📋 Configuration:");
  console.log(`   Phone Number: ${phoneNumber}`);
  console.log(`   WATI URL: ${WATI_URL}`);
  console.log(`   WATI Token: ${WATI_TOKEN ? `${WATI_TOKEN.substring(0, 30)}...` : "NOT SET"}`);
  console.log("");

  if (!WATI_TOKEN) {
    console.error("❌ ERROR: WATI_TOKEN not found in environment variables!");
    console.log("\nPlease add WATI_TOKEN to your .env file:");
    console.log("WATI_TOKEN=your_token_here\n");
    return;
  }

  // Ask user for template name and parameters
  console.log("📝 Please provide your WATI template details:\n");
  console.log("Template Name Examples:");
  console.log("  - order_accepted");
  console.log("  - order_ready");
  console.log("  - payment_reminder");
  console.log("  - Or your custom template name\n");

  // For testing, let's use a simple template
  // You can modify this based on your actual template
  const templateName = "order_accepted"; // Change this to your template name

  const parameters = [
    {
      name: "name",
      value: "Vivek Chaudhari"
    },
    {
      name: "orderNumber",
      value: "TEST-001"
    },
    {
      name: "plant",
      value: "Banana"
    },
    {
      name: "quantity",
      value: "1000"
    },
    {
      name: "delivery",
      value: "25/10/2025"
    },
    {
      name: "amount",
      value: "₹12,000"
    }
  ];

  const body = {
    template_name: templateName,
    broadcast_name: `Test_${Date.now()}`,
    parameters: parameters,
  };

  console.log("📤 Sending WhatsApp message...");
  console.log(`   Template: ${templateName}`);
  console.log(`   Parameters:`, JSON.stringify(parameters, null, 2));
  console.log("");

  try {
    const response = await fetch(
      `${WATI_URL}?whatsappNumber=91${phoneNumber}`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
          Authorization: WATI_TOKEN,
        },
        timeout: 15000,
      }
    );

    const data = await response.json();

    console.log(`📊 Response Status: ${response.status} ${response.statusText}`);
    console.log(`📦 Response Data:`, JSON.stringify(data, null, 2));
    console.log("");

    if (response.ok) {
      console.log("✅ SUCCESS! WhatsApp message sent successfully! 🎉");
      console.log(`✅ Farmer at 91${phoneNumber} should receive the message shortly.`);
    } else {
      console.error("❌ FAILED! WATI API returned an error.");
      console.log("\n🔍 Common Issues:");
      console.log("   1. Template not approved in WATI dashboard");
      console.log("   2. Template name doesn't match exactly");
      console.log("   3. Phone number not registered on WhatsApp");
      console.log("   4. WATI account credits exhausted");
      console.log("   5. Invalid WATI token");
      console.log("\n💡 Check your WATI dashboard: https://app.wati.io/");
    }
  } catch (error) {
    console.error("❌ ERROR:", error.message);
    console.log("\n🔍 Error Details:");
    if (error.type === 'request-timeout') {
      console.log("   The request timed out. WATI server might be slow or unavailable.");
    } else if (error.code === 'ENOTFOUND') {
      console.log("   Could not reach WATI server. Check your internet connection.");
    } else {
      console.log(`   ${error.stack}`);
    }
  }

  console.log("\n" + "=".repeat(60) + "\n");
}

// Run the test
testWatiMessage();







