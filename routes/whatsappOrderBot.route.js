import express from "express";
import { authenticateToken } from "../middlewares/auth.middleware.js";
import {
  handleWhatsAppWebhook,
  startOrderFlow,
} from "../controllers/whatsappOrderBot.controller.js";

const router = express.Router();

// Webhook endpoint for Wati to send incoming messages (PUBLIC - no auth required)
router.post("/webhook", handleWhatsAppWebhook);

// Manual trigger endpoint (for testing/admin - requires authentication)
router.post("/start", authenticateToken, startOrderFlow);

export default router;

