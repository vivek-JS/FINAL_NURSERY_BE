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
import {
  sendWhatsAppMessage,
  sendOrderPlacedAlert,
  getAdminNumbersFromEnv,
} from "../services/whatsappAlertService.js";
import {
  isWhatsAppReady,
  getWhatsAppSessionPath,
  hasPersistedWhatsAppSession,
  getWhatsAppLinkedPhone,
} from "../services/whatsappClient.js";

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

  const results = await Promise.all(
    adminNumbers.map((num) => sendWhatsAppMessage(num, message.trim()))
  );

  const sent = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  const httpStatus = sent === 0 ? 502 : 200;

  return res.status(httpStatus).json({
    status: sent === adminNumbers.length ? "Success" : sent > 0 ? "Partial" : "Fail",
    message:
      sent === adminNumbers.length
        ? `Delivered to all ${sent} admin number(s).`
        : sent > 0
          ? `Delivered to ${sent}, failed for ${failed.length}.`
          : `Failed for all ${failed.length} number(s). Check results and pm2 logs.`,
    linkedBotPhone: getWhatsAppLinkedPhone(),
    whatsappReady: isWhatsAppReady,
    sentTo: adminNumbers,
    results,
  });
});

/** Resend 🟢 New Order Placed alert for an existing order (debug / retry). */
router.post("/new-order/:orderId", async (req, res) => {
  const { orderId } = req.params;
  if (!orderId || !/^[a-f0-9]{24}$/i.test(orderId)) {
    return res.status(400).json({ status: "Fail", message: "Valid MongoDB orderId required in URL." });
  }

  const delivery = await sendOrderPlacedAlert(orderId);
  const ok = (delivery?.delivered || 0) > 0;

  return res.status(ok ? 200 : 502).json({
    status: ok ? "Success" : "Fail",
    message: ok
      ? `New order alert delivered to ${delivery.delivered} admin(s).`
      : `Not delivered. Reason: ${delivery?.reason || delivery?.error || "unknown"}`,
    linkedBotPhone: getWhatsAppLinkedPhone(),
    whatsappReady: isWhatsAppReady,
    delivery,
  });
});

router.get("/status", (req, res) => {
  const sessionPath = getWhatsAppSessionPath();
  return res.status(200).json({
    status: "Success",
    whatsappReady: isWhatsAppReady,
    alertsEnabled: process.env.WHATSAPP_ALERTS_ENABLED === "true",
    linkedBotPhone: getWhatsAppLinkedPhone(),
    adminNumbers: getAdminNumbersFromEnv(),
    sessionPath,
    hasSavedSession: hasPersistedWhatsAppSession(sessionPath),
    hint:
      "Messages are sent FROM linkedBotPhone. Recipients must use WhatsApp on adminNumbers. If test fails, run POST /whatsapp-alert/test and read results[].error.",
  });
});

export default router;
