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

// Webhook endpoint for Wati to send incoming messages (POST - PUBLIC - no auth required)
router.post("/webhook", handleWhatsAppWebhook);

// Manual trigger endpoint (for testing/admin - requires authentication)
router.post("/start", authenticateToken, startOrderFlow);

export default router;

