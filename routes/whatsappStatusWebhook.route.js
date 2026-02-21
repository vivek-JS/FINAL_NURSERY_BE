import express from "express";
import { handleWatiStatusWebhook, statusWebhookHealth } from "../controllers/whatsappStatusWebhook.controller.js";

const router = express.Router();

router.get("/webhook", statusWebhookHealth);
router.post("/webhook", (req, res, next) => {
  console.log("\n📥 [WATI STATUS WEBHOOK] Route hit: POST /api/v1/whatsapp-status/webhook");
  next();
}, handleWatiStatusWebhook);

export default router;

