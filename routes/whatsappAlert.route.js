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
  runScheduledAlertEngine,
  runDailyOpsAlertEngine,
  evaluateOrderAlertsOnCreate,
} from "../services/whatsappAlertEngine.service.js";
import {
  isWhatsAppReady,
  getWhatsAppSessionPath,
  hasPersistedWhatsAppSession,
  getWhatsAppLinkedPhone,
  getWhatsAppQrStatus,
  ensureWhatsAppConnected,
} from "../services/whatsappClient.js";
import { getPendingWhatsAppAlertCount } from "../services/whatsappAlertService.js";

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
  const qr = getWhatsAppQrStatus();
  return res.status(200).json({
    status: "Success",
    whatsappReady: isWhatsAppReady,
    alertsEnabled: process.env.WHATSAPP_ALERTS_ENABLED === "true",
    agriLoadInboundEnabled: process.env.WHATSAPP_AGRI_LOAD_INBOUND_ENABLED !== "false",
    orderFlowEnabled: process.env.WHATSAPP_ORDER_FLOW_ENABLED === "true",
    linkedBotPhone: getWhatsAppLinkedPhone(),
    adminNumbers: getAdminNumbersFromEnv(),
    sessionPath,
    hasSavedSession: hasPersistedWhatsAppSession(sessionPath),
    pendingAlertCount: getPendingWhatsAppAlertCount(),
    qr,
    hint:
      "If whatsappReady is false: POST /reconnect, or scan QR from qr.qrFile on server. Messages send FROM linkedBotPhone.",
  });
});

/** Force reconnect + optional session restore from fallback path. */
router.post("/reconnect", async (req, res) => {
  try {
    const result = await ensureWhatsAppConnected("manual-api");
    return res.status(result.ok ? 200 : 502).json({
      status: result.ok ? "Success" : "Fail",
      whatsappReady: isWhatsAppReady,
      linkedBotPhone: getWhatsAppLinkedPhone(),
      pendingAlertCount: getPendingWhatsAppAlertCount(),
      result,
      qr: getWhatsAppQrStatus(),
    });
  } catch (err) {
    return res.status(500).json({
      status: "Fail",
      message: err?.message || String(err),
    });
  }
});

/** Manual trigger: slot low/high/overbooked scan (SUPER_ADMIN). */
router.post("/engine/slot-scan", async (req, res) => {
  try {
    const result = await runScheduledAlertEngine();
    return res.status(200).json({ status: "Success", result });
  } catch (err) {
    return res.status(500).json({
      status: "Fail",
      message: err?.message || String(err),
    });
  }
});

/** Manual trigger: ops backlog digest. */
router.post("/engine/ops-scan", async (req, res) => {
  try {
    const result = await runDailyOpsAlertEngine();
    return res.status(200).json({ status: "Success", result });
  } catch (err) {
    return res.status(500).json({
      status: "Fail",
      message: err?.message || String(err),
    });
  }
});

/** Re-evaluate big-order alert for an order id. */
router.post("/engine/big-order/:orderId", async (req, res) => {
  const { orderId } = req.params;
  if (!orderId || !/^[a-f0-9]{24}$/i.test(orderId)) {
    return res.status(400).json({ status: "Fail", message: "Valid MongoDB orderId required." });
  }
  try {
    const result = await evaluateOrderAlertsOnCreate(orderId);
    return res.status(200).json({ status: "Success", result });
  } catch (err) {
    return res.status(500).json({
      status: "Fail",
      message: err?.message || String(err),
    });
  }
});

/** Manual trigger: Admin MIS daily digest (Marathi) — booking, dispatch, payments, Ram Agri stock. */
router.post("/engine/admin-daily-mis", async (req, res) => {
  try {
    const { date } = req.body || {};
    const { sendAdminDailyMisMarathiAlert, buildAdminDailyMisWhatsappSnapshot } =
      await import("../services/adminDailyMisWhatsapp.service.js");
    const { formatAdminDailyMisMarathiMessages } =
      await import("../utility/adminDailyMisMarathiFormat.js");

    if (req.query?.preview === "1" || req.body?.preview === true) {
      const snapshot = await buildAdminDailyMisWhatsappSnapshot(date);
      const messages = formatAdminDailyMisMarathiMessages(snapshot);
      return res.status(200).json({
        status: "Success",
        preview: true,
        dateKey: snapshot.dateKey,
        messages,
        snapshot,
      });
    }

    const result = await sendAdminDailyMisMarathiAlert(date);
    const ok = result.sent || (result.delivered || 0) > 0;
    return res.status(ok ? 200 : 502).json({
      status: ok ? "Success" : "Fail",
      message: ok
        ? `Admin MIS WhatsApp sent (${result.delivered} delivery hits, ${result.chunks} chunk(s)).`
        : `Not delivered. Reason: ${result.reason || "unknown"}`,
      result,
    });
  } catch (err) {
    return res.status(500).json({
      status: "Fail",
      message: err?.message || String(err),
    });
  }
});

/** Manual trigger: delivery_final_second scan (past due + due in 7 days). */
router.post("/engine/delivery-final-second-scan", async (req, res) => {
  try {
    const { runDeliveryFinalSecondScan } = await import(
      "../services/deliveryFinalSecondWhatsapp.service.js"
    );
    const result = await runDeliveryFinalSecondScan();
    return res.status(200).json({ status: "Success", result });
  } catch (err) {
    return res.status(500).json({
      status: "Fail",
      message: err?.message || String(err),
    });
  }
});

export default router;
