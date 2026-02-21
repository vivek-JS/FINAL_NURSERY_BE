import catchAsync from "../utility/catchAsync.js";
import Farmer from "../models/farmer.model.js";
import FarmerLead from "../models/farmerLead.model.js";
import { sendWatiTemplateMessage } from "../utility/watiMessaging.js";

/**
 * Parse webhook timestamp to valid Date.
 * Handles: Unix seconds (string/number), Unix ms, ISO string.
 * @param {string|number} ts - Timestamp from webhook
 * @returns {Date} - Valid Date instance
 */
function parseEventTimestamp(ts) {
  if (!ts) return new Date();
  const num = typeof ts === "string" ? parseInt(ts, 10) : Number(ts);
  if (!isNaN(num)) {
    // Unix seconds: 10 digits (e.g. 1771672610); ms: 13 digits
    const date = num < 1e12 ? new Date(num * 1000) : new Date(num);
    if (!isNaN(date.getTime())) return date;
  }
  const iso = new Date(ts);
  return !isNaN(iso.getTime()) ? iso : new Date();
}

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
  // Check if request is from Wati (has Wati user agent)
  const userAgent = req.headers['user-agent'] || '';
  const isWatiWebhook = userAgent.includes('Wati-webhook') || userAgent.includes('wati.io');
  
  // Log incoming webhook request
  console.log("\n" + "=".repeat(60));
  console.log(`📥 [OPT-IN WEBHOOK] Received ${isWatiWebhook ? 'Wati' : 'non-Wati'} request`);
  console.log("=".repeat(60));
  console.log(`   Timestamp: ${new Date().toISOString()}`);
  console.log(`   Method: ${req.method}`);
  console.log(`   URL: ${req.originalUrl || req.url}`);
  console.log(`   User-Agent: ${userAgent}`);
  console.log(`   Is Wati Webhook: ${isWatiWebhook}`);
  console.log(`   Body: ${JSON.stringify(req.body, null, 2)}`);
  console.log("=".repeat(60) + "\n");

  // Early rejection for non-Wati requests without proper webhook format
  if (!isWatiWebhook) {
    // Check for empty body
    if (!req.body || Object.keys(req.body || {}).length === 0) {
      console.log(`\n❌ [OPT-IN WEBHOOK] Empty body from non-Wati source - rejecting`);
      return res.status(400).json({
        success: false,
        message: "This endpoint is for Wati webhooks only",
        received: "Empty request body from browser/frontend",
        note: "This endpoint only accepts webhook events from Wati. Use the correct API endpoints for frontend requests.",
        webhookEndpoint: "/api/v1/opt-in/webhook",
        expectedFormat: {
          eventType: "opt_in or opt_out",
          waId: "Phone number with country code (e.g., 919876543210)"
        }
      });
    }

    // Early detection of login requests
    if (req.body?.phoneNumber && req.body?.password) {
      console.log(`\n❌ [OPT-IN WEBHOOK] Login request detected - wrong endpoint`);
      return res.status(400).json({
        success: false,
        message: "This endpoint is for Wati opt-in/opt-out webhooks only, not login requests",
        received: "Login payload detected",
        correctEndpoint: "/api/v1/user/login",
        webhookEndpoint: "/api/v1/opt-in/webhook",
        note: "Use /api/v1/user/login for authentication. This endpoint only accepts Wati webhook events."
      });
    }

    // If missing required webhook fields, return helpful error
    if (!req.body?.eventType && !req.body?.event && !req.body?.waId) {
      return res.status(400).json({
        success: false,
        message: "This endpoint is for Wati webhooks only",
        received: {
          hasEventType: !!req.body?.eventType,
          hasEvent: !!req.body?.event,
          hasWaId: !!req.body?.waId,
          bodyKeys: Object.keys(req.body || {})
        },
        expectedFormat: {
          eventType: "opt_in or opt_out",
          waId: "Phone number with country code (e.g., 919876543210)"
        },
        example: {
          eventType: "opt_in",
          waId: "919876543210"
        },
        note: "This endpoint only accepts webhook events from Wati. Requests from browsers/frontend are not supported."
      });
    }
  }

  // Extract event type and phone number from webhook payload
  let eventType = null;
  let waId = null;
  let phoneNumber = null;

  // Log the full body structure for debugging
  console.log("\n🔍 [DEBUG] Parsing webhook payload...");
  console.log(`   Body keys: ${Object.keys(req.body || {}).join(', ')}`);
  console.log(`   Body structure: ${JSON.stringify(req.body, null, 2)}`);

  // Handle different webhook payload formats
  // Format 1: Standard Wati format with event and data
  if (req.body?.event && req.body?.data) {
    eventType = req.body.event;
    waId = req.body.data.waId || req.body.data.from || req.body.data.phoneNumber;
    console.log("   ✅ Format 1 detected: event + data");
  }
  // Format 2: Direct eventType format (root level)
  else if (req.body?.eventType) {
    eventType = req.body.eventType;
    waId = req.body.waId || req.body.phoneNumber || req.body.data?.waId || req.body.data?.phoneNumber;
    console.log("   ✅ Format 2 detected: eventType at root");
  }
  // Format 3: Nested in data object
  else if (req.body?.data) {
    eventType = req.body.data.event || req.body.data.eventType || req.body.data.type;
    waId = req.body.data.waId || req.body.data.from || req.body.data.phoneNumber || req.body.data.phone;
    console.log("   ✅ Format 3 detected: nested in data");
  }
  // Format 4: Direct properties at root level
  else if (req.body?.type) {
    eventType = req.body.type; // Sometimes Wati uses "type" instead of "event"
    waId = req.body.waId || req.body.phoneNumber || req.body.phone;
    console.log("   ✅ Format 4 detected: type at root");
  }
  // Format 5: Check for common Wati webhook structure variations
  else {
    // Try to find event/eventType anywhere in the body
    eventType = req.body.event || req.body.eventType || req.body.type;
    waId = req.body.waId || req.body.phoneNumber || req.body.phone || req.body.from;
    console.log("   ⚠️  Format 5: Trying to extract from root level");
  }

  console.log(`   Extracted eventType: ${eventType || 'null'}`);
  console.log(`   Extracted waId: ${waId || 'null'}`);

  // Accept: opt_in, opt_out, and all message events (message = treat as opt-in)
  const isOptOut = eventType === "opt_out";
  const isOptInOrMessage =
    eventType === "opt_in" ||
    eventType === "message" ||
    eventType === "message_received" ||
    eventType === "message_sent";

  if (!isOptInOrMessage && !isOptOut) {
    console.log(`\n⚠️  [OPT-IN WEBHOOK] Invalid or missing event type`);
    console.log(`   Received eventType: ${eventType || "none"}`);
    console.log(`   Expected: "opt_in" or "opt_out"`);
    console.log(`   Full body received: ${JSON.stringify(req.body, null, 2)}`);
    
    // If this looks like a login request or other non-webhook request, return 400
    if (req.body?.phoneNumber && req.body?.password) {
      return res.status(400).json({
        success: false,
        message: "This endpoint is for Wati opt-in/opt-out webhooks only, not login requests",
        received: "Login payload detected",
        endpoint: "/api/v1/opt-in/webhook",
        note: "Use /api/v1/user/login for authentication"
      });
    }
    
    // Return 200 OK to prevent Wati from retrying (for actual Wati webhooks)
    return res.status(isWatiWebhook ? 200 : 400).json({
      success: isWatiWebhook,
      message: isWatiWebhook 
        ? "Webhook received but event type not recognized" 
        : "Invalid request format - this endpoint expects Wati webhook payload",
      receivedEvent: eventType || "none",
      expectedEvents: ["opt_in", "opt_out"],
      note: isWatiWebhook 
        ? "Configure Wati webhook to only send 'opt_in' and 'opt_out' events to this endpoint"
        : "This endpoint only processes Wati opt_in and opt_out webhook events"
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

  // Respond immediately to WATI (avoids timeout, template sends faster)
  res.status(200).json({ success: true, message: "Webhook received, processing..." });

  // Process in background (guidance first so user sees reply faster, then opt-in)
  (async () => {
    try {
      const messageText = req.body?.text || req.body?.buttonReply?.text || req.body?.data?.text || "";
      const GUIDANCE_BUTTON_TEXT = "मार्गदर्शन सुरू करा";
      const followupTemplate = process.env.GUIDANCE_BUTTON_FOLLOWUP_TEMPLATE || "final_first";
      if (messageText?.trim() === GUIDANCE_BUTTON_TEXT && followupTemplate) {
        const senderNameVal = req.body?.senderName || req.body?.data?.senderName || "";
        const nameForTemplate = senderNameVal?.trim() || "भाऊ";
        const joinLink = process.env.GUIDANCE_JOIN_LINK || "";
        const params = [{ name: "1", value: nameForTemplate }];
        if (joinLink) params.push({ name: "2", value: joinLink });
        console.log(`   📤 [GUIDANCE] Sending template ${followupTemplate} to ${phoneNumber} (name: ${nameForTemplate})`);
        const result = await sendWatiTemplateMessage(phoneNumber, followupTemplate, params);
        if (result.success) console.log(`   ✅ [GUIDANCE] Template sent successfully`);
        else console.warn(`   ⚠️ [GUIDANCE] Template send failed:`, result.error);
      }

      const optInValue = isOptOut ? false : true;
    let farmersUpdated = 0;
    let farmersCreated = 0;
    let farmerLeadsUpdated = 0;
    let farmerLeadsCreated = 0;

    // Extract event id and timestamp if provided (for idempotency & audit)
    const eventId =
      req.body?.id ||
      req.body?.eventId ||
      req.body?.data?.id ||
      req.body?.data?.eventId ||
      req.headers["x-wati-event-id"] ||
      null;

    const rawTimestamp =
      req.body?.timestamp || req.body?.data?.timestamp || new Date().toISOString();
    const optInAt = parseEventTimestamp(rawTimestamp);

    // Extract sender name from webhook (Wati sends senderName for message events)
    const senderName =
      req.body?.senderName ||
      req.body?.data?.senderName ||
      req.body?.data?.sender_name ||
      null;
    const farmerName = (senderName && String(senderName).trim()) || "WhatsApp User";

    // Minimal metadata to store (avoid storing entire payload blindly)
    const metadata = {
      raw: req.body,
      userAgent,
      ip: req.ip || req.connection?.remoteAddress || null,
    };

    // Handle Farmer collection (upsert-like behavior)
    const existingFarmer = await Farmer.findOne({ mobileNumber: parseInt(phoneNumber) });

    if (existingFarmer) {
      // Idempotency: if we've already processed this exact webhook event, skip
      if (eventId && existingFarmer.opt_in_webhook_id === eventId) {
        console.log(`   ℹ️  Duplicate event detected for farmer ${phoneNumber} (eventId=${eventId}) - skipping update`);
      } else {
        // Update existing farmer with opt-in details and name if provided
        const updateFields = {
          opt_in: optInValue,
          opt_in_at: optInAt,
          opt_in_source: isWatiWebhook ? "wati-webhook" : "webhook",
          opt_in_webhook_id: eventId,
          opt_in_metadata: metadata,
          opt_in_verified: isWatiWebhook
        };
        if (farmerName !== "WhatsApp User") {
          updateFields.name = farmerName;
        }
        await Farmer.updateOne(
          { mobileNumber: parseInt(phoneNumber) },
          { $set: updateFields }
        );
        farmersUpdated = 1;
        console.log(`   ✅ Updated existing farmer: ${phoneNumber}${farmerName !== "WhatsApp User" ? ` (name: ${farmerName})` : ""}`);
      }
    } else {
      // Create new farmer with number and name from webhook
      const newFarmer = await Farmer.create({
        name: farmerName,
        mobileNumber: parseInt(phoneNumber),
        village: "To be updated",
        taluka: "To be updated",
        district: "To be updated",
        state: "Maharashtra",
        stateName: "Maharashtra",
        talukaName: "To be updated",
        districtName: "To be updated",
        opt_in: optInValue,
        opt_in_at: optInAt,
        opt_in_source: isWatiWebhook ? "wati-webhook" : "webhook",
        opt_in_webhook_id: eventId,
        opt_in_metadata: metadata,
        opt_in_verified: isWatiWebhook
      });
      farmersCreated = 1;
      console.log(`   ✅ Created new farmer: ${phoneNumber} (name: ${farmerName}, ID: ${newFarmer._id})`);
    }

    // Handle FarmerLead collection
    const existingFarmerLead = await FarmerLead.findOne({ mobileNumber: phoneNumber });
    
    if (existingFarmerLead) {
      // Idempotency for lead as well
      if (eventId && existingFarmerLead.opt_in_webhook_id === eventId) {
        console.log(`   ℹ️  Duplicate event detected for farmer lead ${phoneNumber} (eventId=${eventId}) - skipping update`);
      } else {
        // Update existing farmer lead with opt-in details
        const leadUpdateFields = {
          opt_in: optInValue,
          opt_in_at: optInAt,
          opt_in_source: isWatiWebhook ? "wati-webhook" : "webhook",
          opt_in_webhook_id: eventId,
          opt_in_metadata: metadata,
          opt_in_verified: isWatiWebhook
        };
        if (farmerName !== "WhatsApp User") {
          leadUpdateFields.name = farmerName;
        }
        await FarmerLead.updateOne(
          { mobileNumber: phoneNumber },
          { $set: leadUpdateFields }
        );
        farmerLeadsUpdated = 1;
        console.log(`   ✅ Updated existing farmer lead: ${phoneNumber}`);
      }
    } else {
      // Note: FarmerLead requires publicLinkId, so we'll only update if exists
      // We don't create FarmerLead here as it needs more context (publicLinkId)
      console.log(`   ℹ️  No farmer lead found for ${phoneNumber} - skipping (requires publicLinkId)`);
    }

      console.log(`\n✅ [OPT-IN WEBHOOK] Update completed:`);
      console.log(`   Event: ${eventType}`);
      console.log(`   Phone: ${phoneNumber}`);
      console.log(`   opt_in value: ${optInValue}`);
      console.log(`   Farmers updated: ${farmersUpdated}`);
      console.log(`   Farmers created: ${farmersCreated}`);
      console.log(`   FarmerLeads updated: ${farmerLeadsUpdated}`);
    } catch (error) {
      console.error("\n❌ [OPT-IN WEBHOOK] Error updating opt-in status:");
      console.error(`   Error: ${error.message}`);
      console.error(`   Stack: ${error.stack}`);
      console.error(`   Phone: ${phoneNumber}`);
      console.error(`   Event: ${eventType}`);
    }
  })();
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
