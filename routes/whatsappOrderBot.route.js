import express from "express";
import { authenticateToken, authorizeRoles } from "../middlewares/auth.middleware.js";
import {
  handleWhatsAppWebhook,
  startOrderFlow,
  webhookHealthCheck,
  webhookDiagnostics,
  handleInboundOrderMessage,
} from "../controllers/whatsappOrderBot.controller.js";
import { getOrderBotChannels } from "../services/whatsappOrderMessenger.js";
import {
  isWhatsAppReady,
  getWhatsAppLinkedPhone,
  hasPersistedWhatsAppSession,
  getWhatsAppSessionPath,
} from "../services/whatsappClient.js";
import { isWhatsappOrderFlowDisabled } from "../utility/whatsappOrderFlowFlags.js";

const router = express.Router();
const requireOrderBotAdmin = [authenticateToken, authorizeRoles(["SUPER_ADMIN", "ADMIN"])];

/** Public — check if bot can reply (no auth). */
router.get("/status", (req, res) => {
  const sessionPath = getWhatsAppSessionPath();
  return res.status(200).json({
    success: true,
    orderFlowEnabled: !isWhatsappOrderFlowDisabled(),
    ...getOrderBotChannels(),
    whatsappReady: isWhatsAppReady,
    linkedBotPhone: getWhatsAppLinkedPhone(),
    hasSavedSession: hasPersistedWhatsAppSession(sessionPath),
    sessionPath,
    hint: "Message linkedBotPhone (web.js) or your WATI number. Hi/Order must not be blocked by report wizard.",
  });
});

// Health check endpoint (GET - for testing webhook URL)
router.get("/webhook", webhookHealthCheck);

// Diagnostics endpoint (GET - admin only; exposes WATI configuration metadata)
router.get("/diagnostics", requireOrderBotAdmin, webhookDiagnostics);

// Test WATI connectivity endpoint - Diagnose IP blocking
router.get("/test-wati-connectivity", requireOrderBotAdmin, async (req, res) => {
  try {
    const { getWatiBaseUrl, getWatiToken } = await import("../config/wati.config.js");
    const WATI_BASE_URL = getWatiBaseUrl();
    const WATI_TOKEN = getWatiToken();
    
    // Get server's public IP (Render's IP)
    let serverIP = "Unknown";
    try {
      const ipResponse = await fetch("https://api.ipify.org?format=json", { timeout: 5000 });
      const ipData = await ipResponse.json();
      serverIP = ipData.ip;
    } catch (e) {
      console.log("Could not fetch server IP:", e.message);
    }
    
    const testUrl = `${WATI_BASE_URL}/api/v1/sendSessionMessage/917588686453?messageText=Test`;
    const authToken = WATI_TOKEN.startsWith("Bearer ") 
      ? WATI_TOKEN 
      : `Bearer ${WATI_TOKEN}`;
    
    console.log("\n🧪 Testing WATI connectivity from Render...");
    console.log(`   Server IP: ${serverIP}`);
    console.log(`   URL: ${testUrl}`);
    console.log(`   Token: ${authToken.substring(0, 50)}...`);
    
    const startTime = Date.now();
    const response = await fetch(testUrl, {
      method: "POST",
      headers: {
        "Authorization": authToken,
        "User-Agent": "Node.js/WhatsApp-Bot-Test",
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });
    const duration = Date.now() - startTime;
    
    const responseText = await response.text();
    let responseData;
    try {
      responseData = responseText ? JSON.parse(responseText) : {};
    } catch (e) {
      responseData = { raw: responseText };
    }
    
    // Analyze the response
    let diagnosis = "";
    let isIPBlocked = false;
    
    if (response.status === 401) {
      if (responseText === "" || responseData.raw === "") {
        diagnosis = "⚠️ 401 with empty response - Likely IP blocking or token issue";
        isIPBlocked = true;
      } else if (responseData.info?.includes("IP") || responseData.message?.includes("IP")) {
        diagnosis = "🚫 IP BLOCKED - WATI is rejecting requests from this IP";
        isIPBlocked = true;
      } else {
        diagnosis = "🔐 401 Unauthorized - Token may be invalid/expired";
      }
    } else if (response.ok) {
      diagnosis = "✅ Connection successful - IP is not blocked";
    } else {
      diagnosis = `❌ Connection failed with status ${response.status}`;
    }
    
    return res.status(200).json({
      success: true,
      test: "WATI Connectivity & IP Blocking Test",
      serverInfo: {
        ip: serverIP,
        environment: process.env.NODE_ENV || "development",
        platform: "Render",
      },
      request: {
        url: testUrl,
        method: "POST",
        tokenLength: authToken.length,
        tokenPreview: authToken.substring(0, 50) + "...",
      },
      response: {
        status: response.status,
        statusText: response.statusText,
        duration: `${duration}ms`,
        data: responseData,
        headers: Object.fromEntries(response.headers.entries()),
      },
      diagnosis: {
        message: diagnosis,
        isIPBlocked: isIPBlocked,
        isTokenIssue: response.status === 401 && !isIPBlocked,
        isNetworkIssue: response.status === 0 || !response.status,
        recommendations: isIPBlocked ? [
          "1. Check WATI Dashboard → Settings → API → IP Whitelist",
          "2. Disable IP whitelisting OR add Render's IP to whitelist",
          "3. Contact WATI support to whitelist Render IPs",
          `4. Your server IP: ${serverIP}`,
        ] : response.status === 401 ? [
          "1. Verify token is correct in Render environment variables",
          "2. Check if token has expired",
          "3. Regenerate token in WATI dashboard",
        ] : [
          "Connection successful - no issues detected",
        ],
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorType: error.name,
      errorCode: error.code,
      diagnosis: {
        message: error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND'
          ? "❌ Cannot reach WATI API - Network/DNS issue"
          : error.name === 'AbortError' || error.name === 'TimeoutError'
          ? "⏱️ Request timed out"
          : "❌ Test failed",
        isNetworkIssue: true,
      },
    });
  }
});

// Simple test endpoint - immediately returns (for admin debugging)
router.post("/webhook-test", requireOrderBotAdmin, (req, res) => {
  console.log("\n🧪🧪🧪 WEBHOOK TEST ENDPOINT HIT 🧪🧪🧪");
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log(`   Body: ${JSON.stringify(req.body, null, 2)}`);
  console.log("🧪🧪🧪 END TEST 🧪🧪🧪\n");
  res.status(200).json({ 
    success: true, 
    message: "Test endpoint working",
    timestamp: new Date().toISOString(),
    body: req.body 
  });
});

// Webhook endpoint for Wati to send incoming messages (POST - PUBLIC - no auth required)
// Add route-level logger to catch all requests
router.post("/webhook", (req, res, next) => {
  console.log("\n✅✅✅ WEBHOOK ROUTE HIT ✅✅✅");
  console.log(`   Route: POST /api/v1/whatsapp-order/webhook`);
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log(`   Has Body: ${!!req.body}`);
  console.log(`   Body Keys: ${req.body ? Object.keys(req.body).join(', ') : 'none'}`);
  console.log("✅✅✅ PROCEEDING TO CONTROLLER ✅✅✅\n");
  next();
}, handleWhatsAppWebhook);

// Manual trigger endpoint (for testing/admin - requires authentication)
router.post("/start", requireOrderBotAdmin, startOrderFlow);

/** Simulate a farmer message on the scanned WhatsApp session (no WATI). */
router.post("/simulate-web", requireOrderBotAdmin, async (req, res) => {
  const { mobileNumber, text } = req.body || {};
  if (!mobileNumber || !text) {
    return res.status(400).json({
      success: false,
      message: "mobileNumber and text are required",
    });
  }
  const channel = req.body?.channel === "wati" ? "wati" : "webjs";
  await handleInboundOrderMessage({
    chatMobile: mobileNumber,
    text: String(text),
    senderName: req.body?.senderName || "",
    channel,
  });
  return res.status(200).json({
    success: true,
    ...getOrderBotChannels(),
    simulatedChannel: channel,
    whatsappReady: isWhatsAppReady,
    message: `Inbound processed; reply sent on ${channel} channel`,
  });
});

export default router;


