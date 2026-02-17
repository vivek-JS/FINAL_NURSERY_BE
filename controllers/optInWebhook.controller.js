import catchAsync from "../utility/catchAsync.js";
import Farmer from "../models/farmer.model.js";
import FarmerLead from "../models/farmerLead.model.js";

/**
 * Normalize phone number to 10-digit format
 * Removes country code prefix (e.g., "91" for India)
 * @param {string} phone - Phone number with or without country code
 * @returns {string} - 10-digit phone number
 */
function normalizePhoneNumber(phone) {
  if (!phone) return null;
  
  // Convert to string and remove all non-digit characters
  let cleaned = String(phone).replace(/\D/g, "");
  
  // Remove country code prefix (91 for India)
  if (cleaned.length === 12 && cleaned.startsWith("91")) {
    cleaned = cleaned.substring(2);
  }
  
  // Return 10-digit number or null if invalid
  return cleaned.length === 10 ? cleaned : null;
}

/**
 * Handle opt-in/opt-out webhook from Wati
 * Updates opt_in field in Farmer and FarmerLead models based on webhook event
 */
export const handleOptInWebhook = catchAsync(async (req, res) => {
  // Log incoming webhook request
  console.log("\n" + "=".repeat(60));
  console.log("📥 [OPT-IN WEBHOOK] Received webhook from Wati");
  console.log("=".repeat(60));
  console.log(`   Timestamp: ${new Date().toISOString()}`);
  console.log(`   Method: ${req.method}`);
  console.log(`   URL: ${req.originalUrl || req.url}`);
  console.log(`   Headers: ${JSON.stringify(req.headers, null, 2)}`);
  console.log(`   Body: ${JSON.stringify(req.body, null, 2)}`);
  console.log("=".repeat(60) + "\n");

  // Extract event type and phone number from webhook payload
  let eventType = null;
  let waId = null;
  let phoneNumber = null;

  // Handle different webhook payload formats
  // Format 1: Standard Wati format with event and data
  if (req.body?.event && req.body?.data) {
    eventType = req.body.event;
    waId = req.body.data.waId || req.body.data.from;
  }
  // Format 2: Direct eventType format
  else if (req.body?.eventType) {
    eventType = req.body.eventType;
    waId = req.body.waId || req.body.data?.waId;
  }
  // Format 3: Nested in data object
  else if (req.body?.data) {
    eventType = req.body.data.event || req.body.data.eventType;
    waId = req.body.data.waId || req.body.data.from;
  }

  // Validate event type
  if (eventType !== "opt_in" && eventType !== "opt_out") {
    console.log(`⚠️  [OPT-IN WEBHOOK] Invalid or missing event type: ${eventType}`);
    console.log(`   Expected: "opt_in" or "opt_out"`);
    // Return 200 OK to prevent Wati from retrying
    return res.status(200).json({
      success: true,
      message: "Webhook received but event type not recognized",
      receivedEvent: eventType || "none"
    });
  }

  // Validate phone number
  if (!waId) {
    console.log("⚠️  [OPT-IN WEBHOOK] No phone number (waId) found in webhook payload");
    return res.status(200).json({
      success: true,
      message: "Webhook received but phone number not found"
    });
  }

  // Normalize phone number
  phoneNumber = normalizePhoneNumber(waId);
  if (!phoneNumber) {
    console.log(`⚠️  [OPT-IN WEBHOOK] Invalid phone number format: ${waId}`);
    return res.status(200).json({
      success: true,
      message: "Webhook received but phone number format is invalid",
      receivedWaId: waId
    });
  }

  console.log(`\n📱 [OPT-IN WEBHOOK] Processing ${eventType} for phone: ${phoneNumber}`);
  console.log(`   Original waId: ${waId}`);

  // Determine opt_in value based on event type
  const optInValue = eventType === "opt_in" ? true : false;

  try {
    // Update Farmer records
    const farmerUpdateResult = await Farmer.updateMany(
      { mobileNumber: parseInt(phoneNumber) },
      { $set: { opt_in: optInValue } }
    );

    // Update FarmerLead records (mobileNumber is String type)
    const farmerLeadUpdateResult = await FarmerLead.updateMany(
      { mobileNumber: phoneNumber },
      { $set: { opt_in: optInValue } }
    );

    console.log(`\n✅ [OPT-IN WEBHOOK] Update completed:`);
    console.log(`   Event: ${eventType}`);
    console.log(`   Phone: ${phoneNumber}`);
    console.log(`   opt_in value: ${optInValue}`);
    console.log(`   Farmers updated: ${farmerUpdateResult.modifiedCount}`);
    console.log(`   FarmerLeads updated: ${farmerLeadUpdateResult.modifiedCount}`);
    console.log(`   Total matched: ${farmerUpdateResult.matchedCount + farmerLeadUpdateResult.matchedCount}`);

    // Return success response
    return res.status(200).json({
      success: true,
      message: `Opt-in status updated successfully`,
      event: eventType,
      phoneNumber: phoneNumber,
      optIn: optInValue,
      farmersUpdated: farmerUpdateResult.modifiedCount,
      farmerLeadsUpdated: farmerLeadUpdateResult.modifiedCount,
      totalMatched: farmerUpdateResult.matchedCount + farmerLeadUpdateResult.matchedCount
    });

  } catch (error) {
    console.error("\n❌ [OPT-IN WEBHOOK] Error updating opt-in status:");
    console.error(`   Error: ${error.message}`);
    console.error(`   Stack: ${error.stack}`);
    console.error(`   Phone: ${phoneNumber}`);
    console.error(`   Event: ${eventType}`);

    // Return 200 OK even on error to prevent Wati from retrying
    return res.status(200).json({
      success: false,
      message: "Error processing webhook",
      error: error.message
    });
  }
});

/**
 * Health check endpoint for opt-in webhook
 */
export const optInWebhookHealthCheck = catchAsync(async (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Opt-in webhook endpoint is active",
    timestamp: new Date().toISOString(),
    endpoint: "/api/v1/opt-in/webhook"
  });
});
