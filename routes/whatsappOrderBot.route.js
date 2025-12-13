import express from "express";
import { authenticateToken } from "../middlewares/auth.middleware.js";
import {
  handleWhatsAppWebhook,
  startOrderFlow,
  webhookHealthCheck,
} from "../controllers/whatsappOrderBot.controller.js";

const router = express.Router();

// Health check endpoint (GET - for testing webhook URL)
router.get("/webhook", webhookHealthCheck);

// Simple test endpoint - immediately returns (for debugging)
router.post("/webhook-test", (req, res) => {
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
router.post("/start", authenticateToken, startOrderFlow);

export default router;

