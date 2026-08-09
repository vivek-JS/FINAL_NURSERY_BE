import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import fetch from "node-fetch";
import Farmer from "../models/farmer.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import { getWatiBaseUrl, getWatiToken } from "../config/wati.config.js";
import { sendWatiTemplateMessage } from "../utility/watiMessaging.js";
import { runTodayBookingPdfJob } from "../services/bookingReportWebhook.service.js";
import { runWhatsappReportWizardFromWebhookBody } from "../services/whatsappReportWizard.service.js";
import { runFarmReadyWebhookFromBody } from "../services/whatsappFarmReadyReschedule.service.js";
import { runCancelReviveWebhookFromBody } from "../services/whatsappOrderCancelRevive.service.js";
import {
  isWhatsappOrderFlowDisabled,
  isWhatsappOrderWatiEnabled,
} from "../utility/whatsappOrderFlowFlags.js";
import {
  sendOrderBotMessage,
  getOrderBotChannel,
  getOrderBotChannels,
} from "../services/whatsappOrderMessenger.js";
import {
  setOrderReplyChannel,
  clearOrderReplyChannel,
} from "../services/whatsappOrderReplyChannel.js";
import { clearWebJsInboundMessage } from "../services/whatsappOrderWebReply.js";
import {
  normalizeWhatsAppMobile,
  extractMobileFromMessage,
  lookupFarmerByMobile,
  formatFarmerProfileMessage,
  emptyFarmerState,
  isTenDigitMobileMessage,
} from "../services/whatsappOrderFarmer.service.js";
import { ORDER_TRIGGERS } from "../utility/whatsappOrderTriggers.js";
import { extractInboundMessage } from "../utility/watiInboundPayload.js";

function watiBaseUrl() {
  return getWatiBaseUrl();
}
function watiToken() {
  return getWatiToken();
}

// Admin phone number for notifications (from env or default)
const ADMIN_PHONE = process.env.ADMIN_PHONE || "7588686452";

// Store conversation state (in production, use Redis or database)
const conversationState = new Map();

// Log configuration on module load
console.log("\n" + "=".repeat(60));
console.log("🔧 [INIT] WhatsApp Order Bot Configuration");
console.log("=".repeat(60));
console.log(`   NODE_ENV: ${process.env.NODE_ENV || "not set"}`);
console.log(`   WATI_BASE_URL: ${watiBaseUrl() ? "configured" : "NOT SET"}`);
console.log(`   WATI_TOKEN: ${watiToken() ? "configured" : "NOT SET"}`);
console.log(`   WATI_TOKEN from env: ${process.env.WATI_TOKEN ? "✅ YES" : "❌ NO (using default)"}`);
console.log(`   WATI_URL from env: ${process.env.WATI_URL ? `✅ YES (${process.env.WATI_URL})` : "❌ NO (using default)"}`);
console.log(`   ADMIN_PHONE: ${ADMIN_PHONE}`);
console.log(`   Order bot channels: ${JSON.stringify(getOrderBotChannels())}`);
console.log(`   WHATSAPP_ORDER_FLOW_ENABLED: ${process.env.WHATSAPP_ORDER_FLOW_ENABLED || "false"}`);
console.log(`   WHATSAPP_ORDER_DUAL_CHANNEL: ${process.env.WHATSAPP_ORDER_DUAL_CHANNEL || "true (default when both enabled)"}`);
console.log("=".repeat(60) + "\n");

// Validate configuration
if (!watiBaseUrl()) {
  console.error("⚠️  WARNING: WATI_BASE_URL / WATI_URL is not configured!");
}
if (!watiToken()) {
  console.error("⚠️  WARNING: WATI_TOKEN is not configured!");
}

/**
 * Send simple WhatsApp message using Wati API
 * @param {string} phone - Phone number (with or without country code)
 * @param {string} text - Message text to send
 * @returns {Promise<Object>} Send result
 */
/** WATI outbound only — order bot uses sendOrderBotMessage (web.js by default). */
export async function sendOrderBotMessageWati(phone, text) {
  const messageBody = String(text ?? "").trim();
  if (!messageBody) {
    console.error("   ❌ WATI: message text is empty — not sending");
    return { success: false, error: "message text can not be empty" };
  }

  const WATI_TOKEN = watiToken();
  const WATI_BASE_URL = watiBaseUrl();

  console.log("\n📤 [WATI] Preparing to send WhatsApp message...");
  console.log(`   📱 Input phone: ${phone}`);
  console.log(`   📝 Message length: ${messageBody.length} characters`);
  
  try {
    if (!WATI_TOKEN) {
      console.error("   ❌ WATI_TOKEN not configured");
      return { success: false, error: "WATI_TOKEN not configured" };
    }
    
    if (!WATI_BASE_URL) {
      console.error("   ❌ WATI_BASE_URL not configured");
      return { success: false, error: "WATI_BASE_URL not configured" };
    }
    
    console.log(`   ✅ WATI_BASE_URL: ${WATI_BASE_URL}`);
    console.log(`   ✅ WATI_TOKEN length: ${WATI_TOKEN?.length || 0} characters`);
    console.log(`   ✅ WATI_TOKEN preview: ${WATI_TOKEN ? `${WATI_TOKEN.substring(0, 30)}...` : 'MISSING'}`);
    console.log(`   ✅ WATI_TOKEN from env: ${process.env.WATI_TOKEN ? 'YES' : 'NO (using default)'}`);
    
    if (WATI_TOKEN && WATI_TOKEN.includes('.')) {
      try {
        const tokenParts = WATI_TOKEN.split('.');
        if (tokenParts.length === 3) {
          const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
          console.log(`   🔑 Token payload decoded:`, JSON.stringify(payload, null, 2));
          if (payload.exp) {
            const expirationDate = new Date(payload.exp * 1000);
            const now = new Date();
            const isExpired = expirationDate < now;
            const timeUntilExpiry = expirationDate - now;
            console.log(`   🔑 Token expiration: ${expirationDate.toISOString()}`);
            console.log(`   🔑 Current time: ${now.toISOString()}`);
            console.log(`   🔑 Time until expiry: ${Math.floor(timeUntilExpiry / (1000 * 60 * 60))} hours`);
            console.log(`   🔑 Token expired: ${isExpired ? 'YES ⚠️' : 'NO ✅'}`);
            if (isExpired) {
              console.error(`   ❌ TOKEN IS EXPIRED! Please get a new token from WATI dashboard.`);
            }
          } else {
            console.log(`   ⚠️  Token has no expiration claim (exp)`);
          }
          // Log other important claims
          if (payload.tenant_id) {
            console.log(`   🔑 Tenant ID: ${payload.tenant_id}`);
          }
          if (payload.email) {
            console.log(`   🔑 Email: ${payload.email}`);
          }
          if (payload.role) {
            console.log(`   🔑 Role: ${payload.role}`);
          }
        }
      } catch (e) {
        console.error(`   ⚠️  Could not decode token: ${e.message}`);
      }
    }

    // Validate phone number
    if (!phone) {
      console.error("   ❌ Phone number is empty or undefined");
      return { success: false, error: "Phone number is required" };
    }

    // Clean and format phone number
    const cleanNumber = phone.toString().replace(/\D/g, "");
    console.log(`   🔢 Cleaned number: ${cleanNumber}`);
    
    if (!cleanNumber || cleanNumber.length < 10) {
      console.error(`   ❌ Invalid phone number length: ${cleanNumber.length}`);
      return { success: false, error: "Invalid phone number" };
    }
    
    const phoneNumber = cleanNumber.length === 12 && cleanNumber.startsWith("91") 
      ? cleanNumber.substring(2) 
      : cleanNumber;
    
    console.log(`   ✅ Formatted phone: ${phoneNumber}`);

    // Construct URL - ensure no double slashes
    const baseUrl = WATI_BASE_URL.endsWith('/') 
      ? WATI_BASE_URL.slice(0, -1) 
      : WATI_BASE_URL;
    
    // Use query parameter method (PROVEN TO WORK in Postman)
    // Format: POST /api/v1/sendSessionMessage/91{phone}?messageText={encodedMessage}
    const encodedMessage = encodeURIComponent(messageBody);
    const url = `${baseUrl}/api/v1/sendSessionMessage/91${phoneNumber}?messageText=${encodedMessage}`;
    
    console.log(`   🔗 Constructed URL: ${url.substring(0, 200)}${url.length > 200 ? '...' : ''}`);
    console.log(`   📋 URL breakdown:`);
    console.log(`      Base: ${baseUrl}`);
    console.log(`      Endpoint: /api/v1/sendSessionMessage/91${phoneNumber}`);
    console.log(`      Query param: messageText=${messageBody.substring(0, 50)}${messageBody.length > 50 ? '...' : ''}`);
    console.log(`      Encoded message length: ${encodedMessage.length} characters`);
    console.log(`      Full URL length: ${url.length} characters`);
    
    // Validate URL
    try {
      const urlObj = new URL(url); // This will throw if URL is invalid
      console.log("   ✅ URL is valid");
      console.log(`      Protocol: ${urlObj.protocol}`);
      console.log(`      Host: ${urlObj.host}`);
      console.log(`      Path: ${urlObj.pathname}`);
      console.log(`      Query: ${urlObj.search.substring(0, 100)}${urlObj.search.length > 100 ? '...' : ''}`);
    } catch (urlError) {
      console.error("   ❌ Invalid URL:", urlError.message);
      console.error(`   📋 URL components:`);
      console.error(`      Base URL: ${WATI_BASE_URL}`);
      console.error(`      Base URL (cleaned): ${baseUrl}`);
      console.error(`      Phone: 91${phoneNumber}`);
      console.error(`      Full URL: ${url}`);
      return { success: false, error: `Invalid URL: ${urlError.message}` };
    }
    
    // Ensure token has "Bearer " prefix (handle both cases)
    const authToken = WATI_TOKEN.startsWith("Bearer ") 
      ? WATI_TOKEN 
      : `Bearer ${WATI_TOKEN}`;
    
    console.log("   📤 Sending message to WATI API (using query parameter method - PROVEN WORKING)...");
    console.log(`   📋 Request details:`);
    console.log(`      Method: POST`);
    console.log(`      URL: ${url.substring(0, 150)}${url.length > 150 ? '...' : ''}`);
    console.log(`      Authorization header length: ${authToken.length} characters`);
    console.log(`      Authorization header preview: ${authToken.substring(0, 50)}...`);
    console.log(`      Authorization header ends with: ...${authToken.substring(authToken.length - 20)}`);
    console.log(`      Token starts with Bearer: ${authToken.startsWith('Bearer ')}`);
    console.log(`      Token from env: ${process.env.WATI_TOKEN ? 'YES' : 'NO'}`);
    console.log(`      Raw WATI_TOKEN length: ${WATI_TOKEN?.length || 0}`);
    console.log(`      Raw WATI_TOKEN preview: ${WATI_TOKEN ? WATI_TOKEN.substring(0, 50) : 'MISSING'}...`);
    console.log(`      Raw WATI_TOKEN ends with: ${WATI_TOKEN ? '...' + WATI_TOKEN.substring(WATI_TOKEN.length - 20) : 'MISSING'}`);
    console.log(`      Body: EMPTY (using query parameter)`);
    
    // Use query parameter method (as per working Postman request)
    console.log(`   ⏱️  Making fetch request at: ${new Date().toISOString()}`);
    console.log(`   🔑 TOKEN VERIFICATION:`);
    console.log(`      Full authToken: ${authToken}`);
    console.log(`      authToken length: ${authToken.length}`);
    console.log(`      authToken first 100 chars: ${authToken.substring(0, 100)}`);
    console.log(`      authToken last 100 chars: ...${authToken.substring(authToken.length - 100)}`);
    console.log(`      Raw WATI_TOKEN: ${WATI_TOKEN}`);
    console.log(`      Raw WATI_TOKEN length: ${WATI_TOKEN?.length || 0}`);
    console.log(`      process.env.WATI_TOKEN exists: ${!!process.env.WATI_TOKEN}`);
    if (process.env.WATI_TOKEN) {
      console.log(`      process.env.WATI_TOKEN first 100: ${process.env.WATI_TOKEN.substring(0, 100)}`);
      console.log(`      process.env.WATI_TOKEN last 100: ...${process.env.WATI_TOKEN.substring(process.env.WATI_TOKEN.length - 100)}`);
    }
    const fetchStartTime = Date.now();
    
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": authToken,
          "User-Agent": "Node.js/WhatsApp-Bot",
          "Accept": "*/*",
          // NO Content-Type header when using query param
        },
        // NO body - message is in query parameter
        // Add timeout for Render (30 seconds max)
        signal: AbortSignal.timeout(25000), // 25 second timeout
      });
      
      const fetchDuration = Date.now() - fetchStartTime;
      console.log(`   ⏱️  Fetch completed in ${fetchDuration}ms`);
      console.log(`   📡 Response status: ${response.status} ${response.statusText}`);
    } catch (fetchError) {
      const fetchDuration = Date.now() - fetchStartTime;
      console.error(`   ❌ Fetch failed after ${fetchDuration}ms`);
      console.error(`   Error Name: ${fetchError.name}`);
      console.error(`   Error Message: ${fetchError.message}`);
      console.error(`   Error Code: ${fetchError.code || 'N/A'}`);
      console.error(`   Error Stack: ${fetchError.stack}`);
      
      if (fetchError.name === 'AbortError' || fetchError.name === 'TimeoutError') {
        console.error(`   ⏱️  Request timed out - Render may have killed the request`);
        console.error(`   💡 This could be a Render timeout issue (30s limit on free tier)`);
      }
      
      if (fetchError.code === 'ECONNREFUSED' || fetchError.code === 'ENOTFOUND') {
        console.error(`   🌐 Network Error: Cannot reach WATI API from Render`);
        console.error(`   💡 Possible causes:`);
        console.error(`      1. Render is blocking outbound requests to WATI`);
        console.error(`      2. WATI is blocking Render's IP addresses`);
        console.error(`      3. DNS resolution failed`);
        console.error(`   💡 Solution: Check Render's network settings or contact WATI support`);
      }
      
      if (fetchError.message?.includes('certificate') || fetchError.message?.includes('SSL')) {
        console.error(`   🔒 SSL/TLS Error: Certificate validation failed`);
        console.error(`   💡 This could be a certificate issue between Render and WATI`);
      }
      
      throw fetchError;
    }
    
    // Handle response (might be JSON or text)
    let data;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
      console.log("   📡 WATI RESPONSE (JSON):", JSON.stringify(data, null, 2));
    } else {
      const textData = await response.text();
      console.log("   📡 WATI RESPONSE (Text):", textData || '(empty)');
      data = { raw: textData || '' };
    }
    
    // WATI can return 200 OK but with result: false
    // Check both HTTP status AND result field
    const isSuccess = response.ok && data.result !== false;
    
    if (isSuccess) {
      console.log("   ✅ Message sent successfully");
      return { success: true, data };
    } else {
      // If failed, try body format as fallback
      if (response.status === 401 || (response.ok && data.result === false)) {
        console.log("\n   ⚠️  Query param method failed, trying body format with 'message' field...");
        const bodyUrl = `${baseUrl}/api/v1/sendSessionMessage/91${phoneNumber}`;
        console.log(`   🔄 Fallback URL: ${bodyUrl}`);
        
        const fallbackResponse = await fetch(bodyUrl, {
          method: "POST",
          headers: {
            "Authorization": authToken,
            "Content-Type": "application/json",
            "Accept": "application/json",
          },
          body: JSON.stringify({
            message: text,
          }),
        });
        
        console.log(`   📡 Body format fallback - Status: ${fallbackResponse.status} ${fallbackResponse.statusText}`);
        
        // Handle fallback response
        let fallbackData;
        const fallbackContentType = fallbackResponse.headers.get('content-type');
        if (fallbackContentType && fallbackContentType.includes('application/json')) {
          fallbackData = await fallbackResponse.json();
          console.log("   📡 Fallback RESPONSE (JSON):", JSON.stringify(fallbackData, null, 2));
        } else {
          const fallbackText = await fallbackResponse.text();
          console.log("   📡 Fallback RESPONSE (Text):", fallbackText || '(empty)');
          fallbackData = { raw: fallbackText || '' };
        }
        
        if (fallbackResponse.ok && fallbackData.result !== false) {
          console.log("   ✅ Message sent successfully (via fallback)");
          return { success: true, data: fallbackData };
        }
        
        // Fallback also failed, continue with error handling
        data = fallbackData;
        response = fallbackResponse;
      }
      
      console.error("   ❌ WATI API error:");
      console.error(`      Status: ${response.status} ${response.statusText}`);
      console.error(`      Response:`, data);
      
      // Check for specific WATI error messages
      if (data.info) {
        console.error(`      WATI Info: ${data.info}`);
        
        if (data.info.includes("empty") || data.info.includes("session")) {
          console.error("\n   💡 SESSION ERROR:");
          console.error(`      The phone number ${phoneNumber} needs an ACTIVE SESSION.`);
          console.error(`      This means the user must send a message TO your WATI number FIRST.`);
          console.error(`      Once they message you, the session is active for 24 hours.`);
        }
      }
      
      // Special handling for 401 Unauthorized
      if (response.status === 401) {
        console.error("\n   🔐 AUTHENTICATION ERROR:");
        console.error(`      The WATI token appears to be invalid or expired.`);
        console.error(`      Token length: ${WATI_TOKEN?.length || 0}`);
        console.error(`      Token preview: ${WATI_TOKEN ? WATI_TOKEN.substring(0, 50) : 'MISSING'}...`);
        console.error(`      Please check:`);
        console.error(`      1. WATI_TOKEN environment variable`);
        console.error(`      2. Token expiration date`);
        console.error(`      3. Token permissions in WATI dashboard`);
      }
      
      return { success: false, error: data, status: response.status };
    }
  } catch (error) {
    console.error("\n   ❌ [ERROR] Error sending WhatsApp message:");
    console.error(`   Error Type: ${error.name || 'Unknown'}`);
    console.error(`   Error Message: ${error.message}`);
    console.error(`   Error Code: ${error.code || 'N/A'}`);
    console.error(`   Stack: ${error.stack}`);
    console.error(`   URL attempted: ${WATI_BASE_URL}/api/v1/sendSessionMessage/91${phone?.toString().replace(/\D/g, "") || "unknown"}`);
    console.error(`   Phone: ${phone}`);
    console.error(`   Message preview: ${text?.substring(0, 50) || 'empty'}...`);
    console.error(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    
    // Check for specific error types
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      console.error(`   🌐 Network Error: Cannot reach WATI API - Check internet connection or firewall`);
    }
    if (error.message?.includes('fetch') || error.message?.includes('timeout')) {
      console.error(`   🌐 Fetch/Timeout Error: Request timed out or failed`);
    }
    
    return { success: false, error: error.message, errorType: error.name, errorCode: error.code };
  }
}

/**
 * Send admin notification about new order
 */
async function sendAdminNotification(orderData) {
  console.log("\n📤 [NOTIFICATION] Preparing admin notification...");
  console.log(`   📱 Admin phone: ${ADMIN_PHONE}`);
  console.log(`   📋 Order data:`, JSON.stringify(orderData, null, 2));
  
  try {
    const message = `📦 *New WhatsApp Order*

👤 Customer: ${orderData.customerName || "Unknown"}
📱 Phone: ${orderData.mobileNumber}
🌱 Plant: ${orderData.plantName}
🍃 Variety: ${orderData.varietyName}
📦 Cavity: ${orderData.cavity}
🔢 Quantity: ${orderData.quantity}
💵 Amount: ₹${orderData.total}
📅 Delivery: ${orderData.deliveryDate}
🧾 Order ID: ${orderData.orderId || "Processing..."}`;

    console.log("   📝 Notification message prepared");
    await sendOrderBotMessage(ADMIN_PHONE, message);
    console.log("   ✅ Admin notification sent successfully");
  } catch (error) {
    console.error("   ❌ Error sending admin notification:", error);
    console.error("   Stack:", error.stack);
    // Don't fail order creation if notification fails
  }
}

/**
 * Get or initialize conversation state
 */
function getConversationState(mobileNumber) {
  console.log(`\n📂 [STATE] Getting conversation state for: ${mobileNumber}`);
  const existingState = conversationState.get(mobileNumber);
  
  if (existingState) {
    console.log(`   ✅ Found existing state - Step: ${existingState.step}`);
    console.log(`   📋 Order data:`, JSON.stringify(existingState.order, null, 2));
    return existingState;
  }
  
  console.log(`   🆕 Creating new state - Step: MAIN_MENU`);
  const newState = {
    step: "MAIN_MENU",
    chatMobile: mobileNumber,
    farmer: emptyFarmerState(),
    collectField: null,
    order: {
      plant: null,
      plantName: "",
      variety: null,
      varietyName: "",
      rate: 0,
      cavity: null,
      quantity: null,
      deliveryDate: "",
      slotId: null,
      total: 0,
    },
    lists: {
      plants: [],
      varieties: [],
      slots: [],
    },
  };
  conversationState.set(mobileNumber, newState);
  console.log(`   ✅ New state created and saved\n`);
  return newState;
}

/**
 * Save conversation state
 */
function saveConversationState(mobileNumber, state) {
  console.log(`\n💾 [STATE] Saving state for: ${mobileNumber}`);
  console.log(`   📍 Step: ${state.step}`);
  console.log(`   📋 Order:`, JSON.stringify(state.order, null, 2));
  conversationState.set(mobileNumber, state);
  console.log(`   ✅ State saved\n`);
}

/**
 * Clear conversation state
 */
function clearConversationState(mobileNumber) {
  console.log(`\n🗑️  [STATE] Clearing state for: ${mobileNumber}`);
  conversationState.delete(mobileNumber);
  clearOrderReplyChannel(mobileNumber);
  clearWebJsInboundMessage(mobileNumber);
  console.log(`   ✅ State cleared\n`);
}

/** For web.js filter — do not run order bot on random forwarded jokes. */
export function getOrderConversationStep(mobileNumber) {
  const norm =
    normalizeWhatsAppMobile(mobileNumber) ||
    String(mobileNumber).replace(/\D/g, "").slice(-10);
  const state = conversationState.get(norm);
  return state?.step || null;
}

/**
 * Handle incoming WhatsApp webhook from Wati
 */
export const handleWhatsAppWebhook = catchAsync(async (req, res) => {
  const orderFlowOff = isWhatsappOrderFlowDisabled();

  if (!orderFlowOff) {
    // 🔥 RAW WATI WEBHOOK LOGGER
    console.log("\n🔥🔥🔥 RAW WATI WEBHOOK RECEIVED 🔥🔥🔥\n");
    console.log("📋 REQUEST INFO:");
    console.log(`   Method: ${req.method}`);
    console.log(`   URL: ${req.originalUrl || req.url}`);
    console.log(`   Timestamp: ${new Date().toISOString()}\n`);

    console.log("📦 REQUEST BODY:");
    if (req.body && Object.keys(req.body).length > 0) {
      console.log(JSON.stringify(req.body, null, 2));
    } else {
      console.log("   ⚠️  EMPTY BODY");
    }
    console.log("");
  } else {
    const keys = req.body && typeof req.body === "object" ? Object.keys(req.body) : [];
    console.log(
      `[WATI] Webhook (order bot off; booking report still active) — ${req.method} ${req.originalUrl || req.url} keys=[${keys.join(", ")}]`
    );
  }

  // Parse WATI payload (buttonText + text + waId — same helper as farm-ready flow)
  const inbound = extractInboundMessage(req.body);
  let message = String(inbound.text || "").trim();
  let phone = inbound.waId || null;
  let mobileNumber = null;
  let senderName =
    req.body?.senderName ||
    req.body?.data?.senderName ||
    req.body?.data?.sender_name ||
    "";

  if (phone) {
    const digits = String(phone).replace(/\D/g, "");
    mobileNumber =
      digits.length === 12 && digits.startsWith("91")
        ? digits.slice(2)
        : digits.length >= 10
          ? digits.slice(-10)
          : digits;
  }

  if (message && phone) {
    console.log("📩 WATI inbound parsed (extractInboundMessage)");
    console.log(`   Phone: ${phone}, Message: ${message}, Button: ${inbound.buttonText || "—"}`);
  } else if (req.body?.eventType === "message" && req.body?.waId && !message) {
    console.log("⚠️  WATI message event with waId but no text/buttonText — check payload keys:", Object.keys(req.body || {}));
  }

  // Need at least phone; message may be empty for some status-only payloads
  if (!phone) {
    console.log("⚠️  No phone (waId) found in webhook payload");
    return res
      .status(200)
      .json({ success: true, orderFlow: orderFlowOff ? "disabled" : "enabled" });
  }

  if (!orderFlowOff) {
    console.log("\n" + "=".repeat(60));
    console.log("📩 [WEBHOOK] Incoming WhatsApp Message");
    console.log("=".repeat(60));
    console.log(`   📱 Phone: ${phone}`);
    console.log(`   📝 Message: "${message}"`);
    console.log(`   👤 Sender: ${senderName || "Unknown"}`);
    console.log(`   🔢 Clean Mobile: ${mobileNumber}`);
    console.log("=".repeat(60) + "\n");
  } else {
    console.log(
      `[WATI] Message (order bot off): ${phone} — "${String(message).slice(0, 80)}${String(message).length > 80 ? "…" : ""}"`
    );
  }

  // Respond immediately to WATI (avoid timeout)
  console.log("📤 [RESPONSE] Sending 200 OK to WATI immediately");
  res.status(200).json({
    success: true,
    message: orderFlowOff
      ? "Webhook received (order bot disabled)."
      : "Webhook received, processing...",
    orderFlow: orderFlowOff ? "disabled" : "enabled",
  });

  void (async () => {
    try {
      const cancelRevive = await runCancelReviveWebhookFromBody(req.body);
      if (cancelRevive.handled) {
        console.log(`[WATI] Cancel-revive flow handled: ${cancelRevive.action || "ok"}`);
        return;
      }

      const farmReadyOnOrderBot =
        process.env.WHATSAPP_FARM_READY_ON_ORDER_BOT_WEBHOOK === "true";
      if (farmReadyOnOrderBot) {
        const farmReady = await runFarmReadyWebhookFromBody(req.body);
        if (farmReady.handled) {
          console.log(`[WATI] Farm-ready flow handled: ${farmReady.action || "ok"}`);
          return;
        }
      }

      if (orderFlowOff && !message) {
        return;
      }

      if (orderFlowOff) {
        const wizardOnly = await runWhatsappReportWizardFromWebhookBody(req.body);
        if (!wizardOnly.handled && process.env.WHATSAPP_LEGACY_INSTANT_BOOKING_PDF === "true") {
          void runTodayBookingPdfJob(req.body).catch((err) => {
            console.error(
              "[booking report] Legacy instant PDF failed:",
              err?.message || err
            );
          });
        }
        return;
      }

      const hasOrderSession = conversationState.has(mobileNumber);
      const orderPriority =
        isWhatsappOrderWatiEnabled() &&
        (ORDER_TRIGGERS.has(String(message).trim().toLowerCase()) ||
          hasOrderSession ||
          isTenDigitMobileMessage(message));

      if (orderPriority) {
        setOrderReplyChannel(mobileNumber, "wati");
        console.log("🔄 [FLOW] Order bot (priority over report wizard)...");
        await handleInboundOrderMessage({
          chatMobile: mobileNumber,
          text: message,
          senderName: senderName || "",
          channel: "wati",
        });
        console.log("✅ [FLOW] Order flow completed\n");
        return;
      }

      const wizard = await runWhatsappReportWizardFromWebhookBody(req.body);
      if (wizard.handled) {
        return;
      }
      if (process.env.WHATSAPP_LEGACY_INSTANT_BOOKING_PDF === "true") {
        void runTodayBookingPdfJob(req.body).catch((err) => {
          console.error(
            "[booking report] Legacy instant PDF failed:",
            err?.message || err
          );
        });
      }
      if (!isWhatsappOrderWatiEnabled()) {
        console.log("[WATI] Order flow skipped — WATI channel disabled (DISABLE_WHATSAPP_ORDER_WATI).");
        return;
      }
      setOrderReplyChannel(mobileNumber, "wati");
      console.log("🔄 [FLOW] Starting order flow (WATI inbound)...");
      await handleInboundOrderMessage({
        chatMobile: mobileNumber,
        text: message,
        senderName: senderName || "",
        channel: "wati",
      });
      console.log("✅ [FLOW] Order flow processing completed\n");
    } catch (error) {
      console.error("\n❌❌❌ ERROR IN WEBHOOK HANDLER ❌❌❌");
      console.error("   Error:", error.message);
      console.error("   Stack:", error.stack);
      console.error("   Phone:", mobileNumber);
      console.error("   Message:", message);
      console.error("   Error Name:", error.name);
      console.error("   Error Code:", error.code);
      console.error("   Environment:", process.env.NODE_ENV || "development");
      console.error("❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌\n");
    }
  })();
});

/**
 * Inbound order message (whatsapp-web.js session or internal test).
 */
export async function handleInboundOrderMessage({
  chatMobile,
  text,
  senderName = "",
  channel = "webjs",
}) {
  if (isWhatsappOrderFlowDisabled()) {
    return;
  }
  const mobile =
    normalizeWhatsAppMobile(chatMobile) ||
    String(chatMobile).replace(/\D/g, "").slice(-10);
  if (!mobile) {
    return;
  }
  if (channel === "wati" || channel === "webjs") {
    setOrderReplyChannel(mobile, channel);
  }
  const state = getConversationState(mobile);
  await processOrderFlow(mobile, text, state, senderName);
}

/**
 * Main order flow processor
 */
async function processOrderFlow(mobileNumber, userMessage, state, senderName = "") {
  if (isWhatsappOrderFlowDisabled()) {
    return;
  }

  const message = userMessage.trim().toLowerCase();

  console.log("\n" + "─".repeat(60));
  console.log("🔄 [PROCESS] Processing Order Flow");
  console.log("─".repeat(60));
  console.log(`   📱 Mobile: ${mobileNumber}`);
  console.log(`   📝 User Message: "${userMessage}"`);
  console.log(`   📝 Normalized: "${message}"`);
  console.log(`   📍 Current Step: ${state.step}`);
  console.log(`   👤 Sender Name: ${senderName || "Unknown"}`);
  console.log("─".repeat(60));

  // "मार्गदर्शन सुरू करा" button click – send final_first template
  const GUIDANCE_BUTTON_TEXT = "मार्गदर्शन सुरू करा";
  const followupTemplate = process.env.GUIDANCE_BUTTON_FOLLOWUP_TEMPLATE || "final_first";
  if (userMessage?.trim() === GUIDANCE_BUTTON_TEXT && followupTemplate) {
    console.log(`   📤 [GUIDANCE] User clicked "मार्गदर्शन सुरू करा" – sending template: ${followupTemplate}`);
    const nameForTemplate = senderName?.trim() || "भाऊ";
    const joinLink = process.env.GUIDANCE_JOIN_LINK || "";
    const params = [{ name: "1", value: nameForTemplate }];
    if (joinLink) params.push({ name: "2", value: joinLink });
    const result = await sendWatiTemplateMessage(mobileNumber, followupTemplate, params);
    if (result.success) {
      return;
    }
    console.warn(`   ⚠️ [GUIDANCE] Failed to send follow-up template:`, result.error);
  }

  // Global commands (work at any step)
  if (message === "cancel" || message === "0" || message === "रद्द") {
    console.log("   🛑 [COMMAND] CANCEL detected");
    await sendOrderBotMessage(mobileNumber, "❌ ऑर्डर रद्द झाली.\n\nपुन्हा सुरु करण्यासाठी HI टाइप करा.");
    clearConversationState(mobileNumber);
    return;
  }

  if (message === "help" || message === "मदत") {
    console.log("   ❓ [COMMAND] HELP detected");
    await sendOrderBotMessage(
      mobileNumber,
      "📖 *मदत*\n\n• ऑर्डर: ORDER / ऑर्डर / HI\n• मोबाईल नंबर पाठवल्यावर ग्राहक माहिती दिसेल\n• रद्द: CANCEL / 0\n• मेनू: MENU\n• एका संदेशात ऑर्डर (उदा.):\nऑर्डर\nमोबाईल: 98xxxxxxxx\nपिक: केळ\nवाण: ग्रँड नाईन\nगुण: 5000"
    );
    return;
  }

  const scannedMobile = extractMobileFromMessage(userMessage);
  if (
    scannedMobile &&
    (isTenDigitMobileMessage(userMessage) || state.step === "ASK_MOBILE")
  ) {
    await applyFarmerLookup(mobileNumber, state, scannedMobile);
    return;
  }

  if (message === "menu" || message === "मेनू") {
    console.log("   📋 [COMMAND] MENU detected");
    state.step = "MAIN_MENU";
    saveConversationState(mobileNumber, state);
    await handleMainMenu(mobileNumber, state);
    return;
  }

  try {
    console.log(`\n   🎯 [ROUTING] Routing to handler for step: ${state.step}`);
    switch (state.step) {
      case "MAIN_MENU":
        console.log("   → Calling handleMainMenu()");
        await handleMainMenu(mobileNumber, state, message);
        break;

      case "ASK_MOBILE":
        await handleAskMobile(mobileNumber, userMessage, state);
        break;

      case "CONFIRM_FARMER":
        await handleConfirmFarmer(mobileNumber, userMessage, state);
        break;

      case "COLLECT_FARMER":
        await handleCollectFarmer(mobileNumber, userMessage, state);
        break;

      case "SELECT_PLANT":
        console.log("   → Calling handlePlantSelection()");
        await handlePlantSelection(mobileNumber, message, state);
        break;

      case "SELECT_VARIETY":
        console.log("   → Calling handleVarietySelection()");
        await handleVarietySelection(mobileNumber, message, state);
        break;

      case "SELECT_CAVITY":
        console.log("   → Calling handleCavitySelection()");
        await handleCavitySelection(mobileNumber, message, state);
        break;

      case "ENTER_QUANTITY":
        console.log("   → Calling handleQuantity()");
        await handleQuantity(mobileNumber, message, state);
        break;

      case "SELECT_DATE":
        console.log("   → Calling handleDateSelection()");
        await handleDateSelection(mobileNumber, message, state);
        break;

      case "CONFIRM_ORDER":
        console.log("   → Calling handleConfirmation()");
        await handleConfirmation(mobileNumber, message, state);
        break;

      default:
        console.log(`   ⚠️  [WARNING] Unknown step: ${state.step}`);
        await sendOrderBotMessage(
          mobileNumber,
          "मला समजले नाही. कृपया 'HI' टाइप करा."
        );
        state.step = "MAIN_MENU";
        saveConversationState(mobileNumber, state);
    }
    console.log("   ✅ [ROUTING] Handler completed\n");
  } catch (error) {
    console.error("\n❌ [ERROR] Error in order flow:", error);
    console.error("   Stack:", error.stack);
    await sendOrderBotMessage(
      mobileNumber,
      "क्षमस्व, एक त्रुटी आली. पुन्हा सुरु करण्यासाठी 'HI' टाइप करा."
    );
    clearConversationState(mobileNumber);
  }
}

async function promptAskMobile(chatMobile, state) {
  const norm = normalizeWhatsAppMobile(chatMobile);
  await sendOrderBotMessage(
    chatMobile,
    `📱 *ऑर्डर सुरू*\n\n10 अंकी मोबाईल नंबर पाठवा (ग्राहकाचा).\n\nकिंवा या WhatsApp नंबरवरून ऑर्डर करण्यासाठी *1* पाठवा.\n${norm ? `(तुमचा नंबर: ${norm})` : ""}`
  );
  state.step = "ASK_MOBILE";
  saveConversationState(chatMobile, state);
}

async function applyFarmerLookup(chatMobile, state, bookingMobile) {
  const norm = normalizeWhatsAppMobile(bookingMobile);
  if (!norm) {
    await sendOrderBotMessage(chatMobile, "❌ वैध 10 अंकी मोबाईल नंबर पाठवा.");
    state.step = "ASK_MOBILE";
    saveConversationState(chatMobile, state);
    return;
  }

  const farmer = await lookupFarmerByMobile(norm);
  if (farmer) {
    state.farmer = farmer;
    state.step = "CONFIRM_FARMER";
    saveConversationState(chatMobile, state);
    await sendOrderBotMessage(chatMobile, formatFarmerProfileMessage(farmer));
    return;
  }

  state.farmer = { ...emptyFarmerState(), mobileNumber: norm, isNew: true };
  state.step = "COLLECT_FARMER";
  state.collectField = "NAME";
  saveConversationState(chatMobile, state);
  await sendOrderBotMessage(
    chatMobile,
    `❌ मोबाईल *${norm}* नोंदणीत नाही.\n\nकृपया ग्राहकाचे *नाव* पाठवा:`
  );
}

async function startPlantSelectionAfterFarmer(chatMobile, state) {
  state.step = "SELECT_PLANT";
  saveConversationState(chatMobile, state);
  await loadPlants(chatMobile, state, true);
}

async function handleAskMobile(chatMobile, userMessage, state) {
  const trimmed = userMessage.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "1") {
    const own = normalizeWhatsAppMobile(state.chatMobile || chatMobile);
    if (!own) {
      await sendOrderBotMessage(chatMobile, "❌ वैध मोबाईल सापडला नाही. 10 अंकी नंबर टाइप करा.");
      return;
    }
    await applyFarmerLookup(chatMobile, state, own);
    return;
  }

  const fromText = extractMobileFromMessage(trimmed);
  if (fromText) {
    await applyFarmerLookup(chatMobile, state, fromText);
    return;
  }

  await sendOrderBotMessage(
    chatMobile,
    "❌ वैध मोबाईल नाही.\n\n10 अंकी नंबर पाठवा किंवा *1* (या WhatsApp नंबरवरून)."
  );
}

async function handleConfirmFarmer(chatMobile, userMessage, state) {
  const choice = userMessage.trim();
  if (choice === "1") {
    await startPlantSelectionAfterFarmer(chatMobile, state);
    return;
  }
  if (choice === "2") {
    state.step = "ASK_MOBILE";
    state.farmer = emptyFarmerState();
    saveConversationState(chatMobile, state);
    await promptAskMobile(chatMobile, state);
    return;
  }
  await sendOrderBotMessage(chatMobile, "कृपया *1* (होय) किंवा *2* (दुसरा नंबर) पाठवा.");
}

async function handleCollectFarmer(chatMobile, userMessage, state) {
  const text = userMessage.trim();
  if (!text) {
    await sendOrderBotMessage(chatMobile, "❌ रिक्त संदेश. पुन्हा टाइप करा.");
    return;
  }

  switch (state.collectField) {
    case "NAME":
      state.farmer.name = text;
      state.collectField = "DISTRICT";
      saveConversationState(chatMobile, state);
      await sendOrderBotMessage(chatMobile, "📍 *जिल्हा* पाठवा (मराठी/इंग्रजी):");
      break;
    case "DISTRICT":
      state.farmer.district = text;
      state.farmer.districtName = text;
      state.collectField = "TALUKA";
      saveConversationState(chatMobile, state);
      await sendOrderBotMessage(chatMobile, "📍 *तालुका* पाठवा:");
      break;
    case "TALUKA":
      state.farmer.taluka = text;
      state.farmer.talukaName = text;
      state.collectField = "VILLAGE";
      saveConversationState(chatMobile, state);
      await sendOrderBotMessage(chatMobile, "🏘️ *गाव* पाठवा:");
      break;
    case "VILLAGE":
      state.farmer.village = text;
      state.farmer.isNew = true;
      state.collectField = null;
      state.step = "CONFIRM_FARMER";
      saveConversationState(chatMobile, state);
      await sendOrderBotMessage(
        chatMobile,
        formatFarmerProfileMessage(state.farmer, { title: "✅ नवीन ग्राहक तपशील" })
      );
      break;
    default:
      state.collectField = "NAME";
      saveConversationState(chatMobile, state);
      await sendOrderBotMessage(chatMobile, "कृपया ग्राहकाचे *नाव* पाठवा:");
  }
}

/**
 * STEP 0: Main Menu (Greeting)
 */
async function handleMainMenu(mobileNumber, state, message = "") {
  console.log("\n📋 [STEP] MAIN_MENU Handler");
  console.log(`   📝 Input: "${message}"`);

  const messageLower = message.toLowerCase().trim();
  state.chatMobile = mobileNumber;

  if (ORDER_TRIGGERS.has(messageLower)) {
    console.log("   ✅ Order flow — ask mobile first");
    await promptAskMobile(mobileNumber, state);
    return;
  }

  await sendOrderBotMessage(
    mobileNumber,
    "👋 नमस्कार!\n\nऑर्डर सुरू करण्यासाठी *ORDER* किंवा *ऑर्डर* टाइप करा.\n\nमोबाईल नंबर थेट पाठवल्यास ग्राहक माहिती दिसेल."
  );
  saveConversationState(mobileNumber, state);
  console.log("   ✅ MAIN_MENU handler completed\n");
}

/**
 * Load and send available plants
 * @param {boolean} includeGreeting - If true, include greeting message at the start
 */
async function loadPlants(mobileNumber, state, includeGreeting = false) {
  console.log("\n🌱 [LOAD] Loading plants from database...");
  try {
    const plants = await PlantCms.find({}).select("name _id").limit(10);
    console.log(`   📊 Found ${plants.length} plants`);
    
    if (plants.length === 0) {
      console.log("   ⚠️  No plants found");
      await sendOrderBotMessage(mobileNumber, "❌ सध्या कोणतेही रोप उपलब्ध नाहीत.");
      state.step = "MAIN_MENU";
      saveConversationState(mobileNumber, state);
      return;
    }

    // Sort plants to ensure Banana comes first
    const sortedPlants = [...plants].sort((a, b) => {
      // Priority order: Banana first, then others alphabetically
      const priority = { "Banana": 1, "Keli": 1 };
      const aPriority = priority[a.name] || 999;
      const bPriority = priority[b.name] || 999;
      
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
      return a.name.localeCompare(b.name);
    });

    // Plant display names (English first, then Marathi in parentheses)
    const plantDisplayNames = {
      "Banana": "Banana (केळी)",
      "Papaya": "Papaya (पपया)",
      "Watermelon": "Watermelon (तरबूज)",
      "Muskmelon": "Muskmelon (खरबूज)",
      "Keli": "Banana (केळी)",
      "Tarbooj": "Watermelon (तरबूज)",
      "Kharbooj": "Muskmelon (खरबूज)",
    };

    // Start message with greeting if requested
    let message = includeGreeting 
      ? `नमस्कार भाऊ!! 👋🙏🌱\n\n🌱 Ram Biotech मध्ये आपले स्वागत आहे!\n\n🌱 आपल्याला कोणती रोप बुक करायची आहे?\n\n`
      : "🌱 आपल्याला कोणती रोप बुक करायची आहे?\n\n";
    
    state.lists.plants = [];
    sortedPlants.forEach((plant, idx) => {
      const displayName = plantDisplayNames[plant.name] || plant.name;
      message += `${idx + 1}️⃣ ${displayName}\n`;
      state.lists.plants[idx] = {
        id: plant._id.toString(),
        name: plant.name,
      };
      console.log(`   ${idx + 1}. ${plant.name} (Display: ${displayName}) (ID: ${plant._id})`);
    });
    message += "\nनंबर टाइप करा";

    console.log("   ✅ Plants loaded, sending to user");
    await sendOrderBotMessage(mobileNumber, message);
    console.log("   ✅ Plants message sent\n");
  } catch (error) {
    console.error("   ❌ Error loading plants:", error);
    console.error("   Stack:", error.stack);
    await sendOrderBotMessage(mobileNumber, "❌ Error loading plants. Please try again later.");
    state.step = "MAIN_MENU";
    saveConversationState(mobileNumber, state);
  }
}

/**
 * STEP 2: Select Plant
 */
async function handlePlantSelection(mobileNumber, message, state) {
  console.log("\n🌱 [STEP] SELECT_PLANT Handler");
  console.log(`   📝 User input: "${message}"`);
  
  if (!state.lists.plants || state.lists.plants.length === 0) {
    console.log("   ⚠️  Plants list empty, reloading...");
    await loadPlants(mobileNumber, state);
    return;
  }

  const selectedIdx = parseInt(message) - 1;
  console.log(`   🔢 Parsed index: ${selectedIdx} (from input "${message}")`);
  console.log(`   📊 Available plants: ${state.lists.plants.length}`);
  
  if (selectedIdx >= 0 && selectedIdx < state.lists.plants.length) {
    const selectedPlant = state.lists.plants[selectedIdx];
    console.log(`   ✅ Valid selection: ${selectedPlant.name} (ID: ${selectedPlant.id})`);
    
    state.order.plant = selectedPlant.id;
    state.order.plantName = selectedPlant.name;
    console.log(`   💾 Updated order.plant: ${state.order.plant}`);
    console.log(`   💾 Updated order.plantName: ${state.order.plantName}`);
    
    await sendOrderBotMessage(
      mobileNumber,
      `✅ रोप निवडली: ${selectedPlant.name}\n\nविविधता लोड होत आहे...`
    );
    state.step = "SELECT_VARIETY";
    saveConversationState(mobileNumber, state);
    await loadVarieties(mobileNumber, state);
  } else {
    console.log(`   ❌ Invalid selection (index ${selectedIdx} out of range)`);
    await sendOrderBotMessage(mobileNumber, "❌ Invalid selection. Please try again:");
    await loadPlants(mobileNumber, state);
  }
  saveConversationState(mobileNumber, state);
  console.log("   ✅ SELECT_PLANT handler completed\n");
}

/**
 * Load and send varieties (subtypes)
 */
async function loadVarieties(mobileNumber, state) {
  console.log("\n🍃 [LOAD] Loading varieties for plant:", state.order.plant);
  try {
    const plant = await PlantCms.findById(state.order.plant).select("subtypes name");
    console.log(`   📊 Plant found: ${plant?.name || "Not found"}`);
    
    if (!plant || !plant.subtypes || plant.subtypes.length === 0) {
      console.log("   ⚠️  No varieties found");
      await sendOrderBotMessage(mobileNumber, "❌ No varieties available for this plant.");
      state.step = "SELECT_PLANT";
      saveConversationState(mobileNumber, state);
      await loadPlants(mobileNumber, state);
      return;
    }

    console.log(`   📊 Found ${plant.subtypes.length} varieties`);
    let message = `🍃 ${plant.name} च्या विविधता:\n\n`;
    state.lists.varieties = [];
    plant.subtypes.forEach((subtype, idx) => {
      // Get the first rate from rates array, or default to 0
      const rate = subtype.rates && subtype.rates.length > 0 ? subtype.rates[0] : 0;
      message += `${idx + 1}️⃣ ${subtype.name} – ₹${rate}\n`;
      state.lists.varieties[idx] = {
        id: subtype._id.toString(),
        name: subtype.name,
        rate: rate,
      };
      console.log(`   ${idx + 1}. ${subtype.name} - ₹${rate} (ID: ${subtype._id})`);
    });
    message += "\nविविधता निवडा";

    console.log("   ✅ Varieties loaded, sending to user");
    await sendOrderBotMessage(mobileNumber, message);
    console.log("   ✅ Varieties message sent\n");
  } catch (error) {
    console.error("   ❌ Error loading varieties:", error);
    console.error("   Stack:", error.stack);
    await sendOrderBotMessage(mobileNumber, "❌ Error loading varieties. Please try again.");
    state.step = "SELECT_PLANT";
    saveConversationState(mobileNumber, state);
    await loadPlants(mobileNumber, state);
  }
}

/**
 * STEP 3: Select Variety
 */
async function handleVarietySelection(mobileNumber, message, state) {
  console.log("\n🍃 [STEP] SELECT_VARIETY Handler");
  console.log(`   📝 User input: "${message}"`);
  
  if (!state.lists.varieties || state.lists.varieties.length === 0) {
    console.log("   ⚠️  Varieties list empty, reloading...");
    await loadVarieties(mobileNumber, state);
    return;
  }

  const selectedIdx = parseInt(message) - 1;
  console.log(`   🔢 Parsed index: ${selectedIdx} (from input "${message}")`);
  console.log(`   📊 Available varieties: ${state.lists.varieties.length}`);
  
  if (selectedIdx >= 0 && selectedIdx < state.lists.varieties.length) {
    const selectedVariety = state.lists.varieties[selectedIdx];
    console.log(`   ✅ Valid selection: ${selectedVariety.name} (ID: ${selectedVariety.id}, Rate: ₹${selectedVariety.rate})`);
    
    state.order.variety = selectedVariety.id;
    state.order.varietyName = selectedVariety.name;
    state.order.rate = selectedVariety.rate;
    console.log(`   💾 Updated order.variety: ${state.order.variety}`);
    console.log(`   💾 Updated order.varietyName: ${state.order.varietyName}`);
    console.log(`   💾 Updated order.rate: ₹${state.order.rate}`);
    
    await sendOrderBotMessage(
      mobileNumber,
      `✅ विविधता: ${selectedVariety.name}\nदर: ₹${selectedVariety.rate}\n\n📦 ट्रे कॅविटी निवडा:\n\n1️⃣ 50\n2️⃣ 100\n3️⃣ 200`
    );
    state.step = "SELECT_CAVITY";
    saveConversationState(mobileNumber, state);
  } else {
    console.log(`   ❌ Invalid selection (index ${selectedIdx} out of range)`);
    await sendOrderBotMessage(mobileNumber, "❌ Invalid selection. Please try again:");
    await loadVarieties(mobileNumber, state);
  }
  saveConversationState(mobileNumber, state);
  console.log("   ✅ SELECT_VARIETY handler completed\n");
}

/**
 * STEP 4: Select Cavity
 */
async function handleCavitySelection(mobileNumber, message, state) {
  console.log("\n📦 [STEP] SELECT_CAVITY Handler");
  console.log(`   📝 User input: "${message}"`);
  
  const cavities = ["50", "100", "200"];
  const selectedIdx = parseInt(message) - 1;
  console.log(`   🔢 Parsed index: ${selectedIdx} (from input "${message}")`);
  console.log(`   📊 Available cavities: ${cavities.join(", ")}`);

  if (selectedIdx >= 0 && selectedIdx < cavities.length) {
    const selectedCavity = cavities[selectedIdx];
    console.log(`   ✅ Valid selection: ${selectedCavity}`);
    
    state.order.cavity = selectedCavity;
    console.log(`   💾 Updated order.cavity: ${state.order.cavity}`);
    
    await sendOrderBotMessage(
      mobileNumber,
      `✅ कॅविटी: ${selectedCavity}\n\n🔢 प्रमाण टाइप करा (फक्त नंबर)\n\nउदाहरण: 500`
    );
    state.step = "ENTER_QUANTITY";
    saveConversationState(mobileNumber, state);
  } else {
    console.log(`   ❌ Invalid selection (index ${selectedIdx} out of range)`);
    await sendOrderBotMessage(mobileNumber, "❌ Invalid selection. Please select 1, 2, or 3:");
  }
  saveConversationState(mobileNumber, state);
  console.log("   ✅ SELECT_CAVITY handler completed\n");
}

/**
 * STEP 5: Enter Quantity
 */
async function handleQuantity(mobileNumber, message, state) {
  console.log("\n🔢 [STEP] ENTER_QUANTITY Handler");
  console.log(`   📝 User input: "${message}"`);
  
  const quantity = parseInt(message);
  console.log(`   🔢 Parsed quantity: ${quantity}`);
  console.log(`   💰 Current rate: ₹${state.order.rate}`);
  
  if (isNaN(quantity) || quantity <= 0 || quantity > 10000) {
    console.log(`   ❌ Invalid quantity: ${quantity} (must be 1-10000)`);
    await sendOrderBotMessage(
      mobileNumber,
      "❌ Invalid quantity. Please enter a number between 1 and 10000:"
    );
    return;
  }

  state.order.quantity = quantity;
  state.order.total = quantity * parseFloat(state.order.rate);
  console.log(`   ✅ Valid quantity: ${quantity}`);
  console.log(`   💾 Updated order.quantity: ${state.order.quantity}`);
  console.log(`   💾 Updated order.total: ₹${state.order.total}`);
  console.log(`   💵 Calculation: ${quantity} × ₹${state.order.rate} = ₹${state.order.total}`);
  
    await sendOrderBotMessage(
      mobileNumber,
      `✅ प्रमाण: ${quantity}\n\nउपलब्ध डिलिव्हरी तारखा लोड होत आहेत...`
    );
  
  state.step = "SELECT_DATE";
  saveConversationState(mobileNumber, state);
  await loadDeliveryDates(mobileNumber, state);
  console.log("   ✅ ENTER_QUANTITY handler completed\n");
}

/**
 * Load and send available delivery dates
 */
async function loadDeliveryDates(mobileNumber, state) {
  console.log("\n📅 [LOAD] Loading delivery slots...");
  console.log(`   🌱 Plant ID: ${state.order.plant}`);
  console.log(`   🍃 Variety ID: ${state.order.variety}`);
  
  try {
    const slots = await PlantSlot.find({
      plantId: state.order.plant,
      subtypeId: state.order.variety,
      availableQuantity: { $gt: 0 },
    })
      .sort({ startDay: 1 })
      .limit(5)
      .select("startDay endDay availableQuantity _id");

    console.log(`   📊 Found ${slots.length} available slots`);

    if (slots.length === 0) {
      console.log("   ⚠️  No slots found");
      await sendOrderBotMessage(
        mobileNumber,
        "❌ No delivery slots available. Please try a different plant/variety."
      );
      state.step = "SELECT_PLANT";
      saveConversationState(mobileNumber, state);
      await loadPlants(mobileNumber, state);
      return;
    }

    let message = "📅 डिलिव्हरी आठवडा निवडा:\n\n";
    state.lists.slots = [];
    slots.forEach((slot, idx) => {
      message += `${idx + 1}️⃣ ${slot.startDay}–${slot.endDay} (उपलब्ध: ${slot.availableQuantity})\n`;
      state.lists.slots[idx] = {
        id: slot._id.toString(),
        startDay: slot.startDay,
        endDay: slot.endDay,
      };
      console.log(`   ${idx + 1}. ${slot.startDay}–${slot.endDay} (Available: ${slot.availableQuantity}, ID: ${slot._id})`);
    });

    console.log("   ✅ Slots loaded, sending to user");
    await sendOrderBotMessage(mobileNumber, message);
    console.log("   ✅ Slots message sent\n");
  } catch (error) {
    console.error("   ❌ Error loading slots:", error);
    console.error("   Stack:", error.stack);
    await sendOrderBotMessage(mobileNumber, "❌ Error loading delivery dates. Please try again.");
    state.step = "SELECT_PLANT";
    saveConversationState(mobileNumber, state);
    await loadPlants(mobileNumber, state);
  }
}

/**
 * STEP 6: Select Delivery Date
 */
async function handleDateSelection(mobileNumber, message, state) {
  console.log("\n📅 [STEP] SELECT_DATE Handler");
  console.log(`   📝 User input: "${message}"`);
  
  if (!state.lists.slots || state.lists.slots.length === 0) {
    console.log("   ⚠️  Slots list empty, reloading...");
    await loadDeliveryDates(mobileNumber, state);
    return;
  }

  const selectedIdx = parseInt(message) - 1;
  console.log(`   🔢 Parsed index: ${selectedIdx} (from input "${message}")`);
  console.log(`   📊 Available slots: ${state.lists.slots.length}`);
  
  if (selectedIdx >= 0 && selectedIdx < state.lists.slots.length) {
    const slot = state.lists.slots[selectedIdx];
    console.log(`   ✅ Valid selection: ${slot.startDay}–${slot.endDay} (ID: ${slot.id})`);
    
    state.order.deliveryDate = `${slot.startDay} to ${slot.endDay}`;
    state.order.slotId = slot.id;
    console.log(`   💾 Updated order.deliveryDate: ${state.order.deliveryDate}`);
    console.log(`   💾 Updated order.slotId: ${state.order.slotId}`);

    // Show order summary
    const f = state.farmer || emptyFarmerState();
    const summary = `📋 *ऑर्डर सारांश*

👤 ${f.name || "—"} | 📱 ${f.mobileNumber || "—"}
🏘️ ${f.village || "—"} | ${f.talukaName || f.taluka || "—"} | ${f.districtName || f.district || "—"}

🌱 रोप: ${state.order.plantName}
🍃 विविधता: ${state.order.varietyName}
📦 कॅविटी: ${state.order.cavity}
🔢 प्रमाण: ${state.order.quantity}
💰 दर: ₹${state.order.rate}
💵 एकूण: ₹${state.order.total}
📅 डिलिव्हरी: ${state.order.deliveryDate}

📌 स्टेटस: PENDING (WhatsApp)

उत्तर द्या:
1️⃣ ऑर्डर पुष्टी करा
2️⃣ रद्द करा`;

    console.log("   📋 Showing order summary to user");
    await sendOrderBotMessage(mobileNumber, summary);
    state.step = "CONFIRM_ORDER";
    saveConversationState(mobileNumber, state);
  } else {
    console.log(`   ❌ Invalid selection (index ${selectedIdx} out of range)`);
    await sendOrderBotMessage(mobileNumber, "❌ Invalid selection. Please try again:");
    await loadDeliveryDates(mobileNumber, state);
  }
  saveConversationState(mobileNumber, state);
  console.log("   ✅ SELECT_DATE handler completed\n");
}

/**
 * STEP 7: Confirmation - Create Order
 */
async function handleConfirmation(mobileNumber, message, state) {
  console.log("\n✅ [STEP] CONFIRM_ORDER Handler");
  console.log(`   📝 User input: "${message}"`);
  
  if (message === "1" || message === "confirm" || message === "yes") {
    console.log("   ✅ User confirmed order");
    await sendOrderBotMessage(
      mobileNumber,
      "⏳ आपली ऑर्डर प्रक्रिया करत आहे... कृपया प्रतीक्षा करा."
    );

    try {
      const f = state.farmer || emptyFarmerState();
      const bookingMobile = normalizeWhatsAppMobile(f.mobileNumber || mobileNumber);
      console.log("\n   👤 [FARMER] Using session farmer:", bookingMobile);

      console.log("\n   📦 [ORDER] Preparing order payload...");
      const orderPayload = {
        name: f.name || "WhatsApp Customer",
        mobileNumber: bookingMobile,
        village: f.village || "To be updated",
        taluka: f.taluka || f.talukaName || "To be updated",
        district: f.district || f.districtName || "To be updated",
        state: f.state || f.stateName || "Maharashtra",
        stateName: f.stateName || f.state || "Maharashtra",
        districtName: f.districtName || f.district || "To be updated",
        talukaName: f.talukaName || f.taluka || "To be updated",
        typeOfPlants: "",
        numberOfPlants: state.order.quantity,
        rate: parseFloat(state.order.rate),
        paymentStatus: "not paid",
        orderStatus: "PENDING",
        orderSource: "WHATSAPP",
        bookedViaWhatsApp: true,
        whatsappBookingMobile: bookingMobile,
        plantName: state.order.plant,
        plantSubtype: state.order.variety,
        bookingSlot: state.order.slotId,
        deliveryDate: new Date().toISOString(),
        orderPaymentStatus: "PENDING",
        cavity: parseInt(state.order.cavity),
        orderBookingDate: new Date().toISOString(),
        orderRemarks: ["Booked via WhatsApp order bot"],
        salesPerson: process.env.WHATSAPP_DEFAULT_SALES_PERSON_ID || undefined,
      };

      if (!orderPayload.salesPerson) {
        throw new Error(
          "WHATSAPP_DEFAULT_SALES_PERSON_ID is not set in .env (required for createFarmer validation)"
        );
      }
      console.log("   📋 Order payload:", JSON.stringify(orderPayload, null, 2));

      const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8000";
      const orderUrl = `${API_BASE_URL}/api/v1/farmer/createFarmer`;
      console.log(`\n   🌐 [API] Calling order creation endpoint: ${orderUrl}`);

      const apiHeaders = { "Content-Type": "application/json" };
      if (process.env.WHATSAPP_ORDER_API_TOKEN) {
        apiHeaders.Authorization = `Bearer ${process.env.WHATSAPP_ORDER_API_TOKEN}`;
      }

      const orderResponse = await fetch(orderUrl, {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify(orderPayload),
      });

      console.log(`   📡 [API] Response status: ${orderResponse.status}`);
      const orderResult = await orderResponse.json();
      console.log("   📡 [API] Response data:", JSON.stringify(orderResult, null, 2));

      if (orderResult.success || orderResult.data) {
        const orderId = orderResult.data?.orderId || orderResult.orderId || "Processing...";
        console.log(`   ✅ Order created successfully! Order ID: ${orderId}`);
        
        await sendOrderBotMessage(
          mobileNumber,
          `✅ *ऑर्डर यशस्वीरित्या झाली!*\n\n🧾 ऑर्डर ID: ${orderId}\n📅 डिलिव्हरी: ${state.order.deliveryDate}\n\nधन्यवाद 🙏\n\nदुसरी ऑर्डर करण्यासाठी HI टाइप करा`
        );

        // Send admin notification
        console.log("\n   📤 [NOTIFICATION] Sending admin notification...");
        await sendAdminNotification({
          customerName: f.name || "Unknown",
          mobileNumber: bookingMobile,
          plantName: state.order.plantName,
          varietyName: state.order.varietyName,
          cavity: state.order.cavity,
          quantity: state.order.quantity,
          total: state.order.total,
          deliveryDate: state.order.deliveryDate,
          orderId: orderId,
        });
        console.log("   ✅ Admin notification sent");

        clearConversationState(mobileNumber);
        console.log("   ✅ CONFIRM_ORDER handler completed successfully\n");
      } else {
        console.error("   ❌ Order creation failed - API returned error");
        throw new Error("Order creation failed");
      }
    } catch (error) {
      console.error("\n   ❌ [ERROR] Error creating order:", error);
      console.error("   Stack:", error.stack);
    await sendOrderBotMessage(
      mobileNumber,
      "❌ आपली ऑर्डर प्रक्रिया करताना त्रुटी आली. कृपया पुन्हा प्रयत्न करा किंवा सपोर्टशी संपर्क साधा."
    );
      clearConversationState(mobileNumber);
    }
  } else {
    console.log("   ❌ User cancelled order");
    await sendOrderBotMessage(mobileNumber, "❌ Order cancelled.\n\nType HI to start again.");
    clearConversationState(mobileNumber);
  }
}

/**
 * Health check endpoint for webhook (GET request)
 */
export const webhookHealthCheck = catchAsync(async (req, res) => {
  const channels = getOrderBotChannels();
  return res.status(200).json(
    generateResponse("success", "WhatsApp order bot status", {
      ...channels,
      orderFlowEnabled: process.env.WHATSAPP_ORDER_FLOW_ENABLED === "true",
      watiWebhook: "/api/v1/whatsapp-order/webhook",
      webJsInbound: "messages to the scanned WhatsApp number (same session as alerts)",
      hint:
        channels.mode === "dual"
          ? "Farmers can use either channel; replies go back on the same channel they used."
          : null,
      timestamp: new Date().toISOString(),
    })
  );
});

/**
 * Diagnostic endpoint to check WATI configuration
 */
export const webhookDiagnostics = catchAsync(async (req, res) => {
  const diagnostics = {
    environment: process.env.NODE_ENV || "not set",
    wati: {
      baseUrl: watiBaseUrl() || "❌ NOT SET",
      baseUrlFromEnv: process.env.WATI_URL || process.env.WATI_BASE_URL || "❌ NOT SET",
      tokenConfigured: watiToken() ? "✅ YES" : "❌ NO",
      tokenFromEnv: process.env.WATI_TOKEN ? "✅ YES" : "❌ NO",
      tokenLength: watiToken()?.length || 0,
      tokenPreview: watiToken() ? `${watiToken().substring(0, 30)}...` : "MISSING",
    },
    admin: {
      phone: ADMIN_PHONE,
      phoneFromEnv: process.env.ADMIN_PHONE || "❌ NOT SET",
    },
    orderBot: {
      ...getOrderBotChannels(),
      flowEnabled: process.env.WHATSAPP_ORDER_FLOW_ENABLED === "true",
      dualChannelEnv: process.env.WHATSAPP_ORDER_DUAL_CHANNEL === "true",
    },
    timestamp: new Date().toISOString(),
  };

  // Check token expiration if it's a JWT
  const diagToken = watiToken();
  if (diagToken && diagToken.includes('.')) {
    try {
      const tokenParts = diagToken.split('.');
      if (tokenParts.length === 3) {
        const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
        if (payload.exp) {
          const expirationDate = new Date(payload.exp * 1000);
          const now = new Date();
          const isExpired = expirationDate < now;
          diagnostics.wati.tokenExpiration = expirationDate.toISOString();
          diagnostics.wati.tokenExpired = isExpired;
        }
      }
    } catch (e) {
      diagnostics.wati.tokenParseError = "Could not parse token";
    }
  }

  return res.status(200).json(
    generateResponse("success", "WhatsApp webhook diagnostics", diagnostics)
  );
});

/**
 * Manual trigger to start order flow (for testing)
 */
export const startOrderFlow = catchAsync(async (req, res) => {
  const { mobileNumber } = req.body;

  if (!mobileNumber) {
    return res.status(400).json(
      generateResponse("error", "Mobile number is required", null)
    );
  }

  const state = getConversationState(mobileNumber);
  state.step = "MAIN_MENU";
  saveConversationState(mobileNumber, state);

  await handleMainMenu(mobileNumber, state);

  return res.status(200).json(
    generateResponse("success", "Order flow started", { mobileNumber })
  );
});
