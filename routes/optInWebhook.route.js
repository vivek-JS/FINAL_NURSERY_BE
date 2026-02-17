import express from "express";
import {
  handleOptInWebhook,
  optInWebhookHealthCheck,
} from "../controllers/optInWebhook.controller.js";

const router = express.Router();

// Health check endpoint (GET - for testing webhook URL)
router.get("/webhook", optInWebhookHealthCheck);

// Webhook endpoint for Wati opt-in/opt-out events (POST - PUBLIC - no auth required)
// Add route-level logger to catch all requests
router.post("/webhook", (req, res, next) => {
  console.log("\n✅✅✅ OPT-IN WEBHOOK ROUTE HIT ✅✅✅");
  console.log(`   Route: POST /api/v1/opt-in/webhook`);
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log(`   Has Body: ${!!req.body}`);
  console.log(`   Body Keys: ${req.body ? Object.keys(req.body).join(', ') : 'none'}`);
  console.log("✅✅✅ PROCEEDING TO CONTROLLER ✅✅✅\n");
  next();
}, handleOptInWebhook);

export default router;
