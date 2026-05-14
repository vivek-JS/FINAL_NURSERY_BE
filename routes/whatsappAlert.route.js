/**
 * WhatsApp Alert Routes
 *
 * POST /api/v1/whatsapp-alert/test
 *   Body: { "message": "Test alert from ERP" }
 *   Sends the message to all WHATSAPP_ADMIN_NUMBERS.
 *
 * POST /api/v1/whatsapp-alert/status
 *   Returns whether the WhatsApp client is ready.
 */

import express from "express";
import { sendWhatsAppMessage, getAdminNumbersFromEnv } from "../services/whatsappAlertService.js";
import { isWhatsAppReady } from "../services/whatsappClient.js";

const router = express.Router();

router.post("/test", async (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ status: "Fail", message: "message is required in request body." });
  }

  const adminNumbers = getAdminNumbersFromEnv();
  if (adminNumbers.length === 0) {
    return res.status(400).json({
      status: "Fail",
      message: "No admin numbers configured. Set WHATSAPP_ADMIN_NUMBERS in .env",
    });
  }

  const results = await Promise.allSettled(
    adminNumbers.map((num) => sendWhatsAppMessage(num, message.trim()))
  );

  const sent = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  return res.status(200).json({
    status: "Success",
    message: `Alert sent to ${sent} number(s)${failed > 0 ? `, failed for ${failed}` : ""}.`,
    sentTo: adminNumbers,
  });
});

router.get("/status", (req, res) => {
  return res.status(200).json({
    status: "Success",
    whatsappReady: isWhatsAppReady,
    alertsEnabled: process.env.WHATSAPP_ALERTS_ENABLED === "true",
    adminNumbers: getAdminNumbersFromEnv(),
  });
});

export default router;
