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
  flushPendingWhatsAppAlerts,
  sendLinkedAgriAlertForOrderIds,
} from "../services/whatsappAlertService.js";
import Dispatch from "../models/dispatch.model.js";
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
    hint: isWhatsAppReady
      ? "WhatsApp connected. Messages send FROM linkedBotPhone."
      : getPendingWhatsAppAlertCount() > 0
        ? `WhatsApp disconnected — ${getPendingWhatsAppAlertCount()} alert(s) queued. POST /reconnect?background=1 then check status; scan QR on server if session expired.`
        : "If whatsappReady is false: POST /reconnect?background=1, or scan QR from qr.qrFile on server.",
  });
});

/** Force reconnect + optional session restore from fallback path. */
router.post("/reconnect", async (req, res) => {
  const background = req.query?.background === "1" || req.body?.background === true;

  if (background) {
    void ensureWhatsAppConnected("manual-api-background").then(async (result) => {
      if (result.ok) {
        try {
          await flushPendingWhatsAppAlerts();
        } catch (e) {
          console.error("[WhatsApp Alert] Background flush failed:", e?.message || e);
        }
      }
    });
    return res.status(202).json({
      status: "Accepted",
      message: "Reconnect started in background. Check GET /status in ~1–2 min.",
      whatsappReady: isWhatsAppReady,
      pendingAlertCount: getPendingWhatsAppAlertCount(),
    });
  }

  try {
    const result = await ensureWhatsAppConnected("manual-api");
    let flush = { flushed: 0, remaining: getPendingWhatsAppAlertCount() };
    if (result.ok) {
      flush = await flushPendingWhatsAppAlerts();
    }
    return res.status(result.ok ? 200 : 502).json({
      status: result.ok ? "Success" : "Fail",
      whatsappReady: isWhatsAppReady,
      linkedBotPhone: getWhatsAppLinkedPhone(),
      pendingAlertCount: getPendingWhatsAppAlertCount(),
      result,
      flush,
      qr: getWhatsAppQrStatus(),
    });
  } catch (err) {
    return res.status(500).json({
      status: "Fail",
      message: err?.message || String(err),
    });
  }
});

/** Flush queued alerts after WhatsApp reconnects. */
router.post("/flush-pending", async (req, res) => {
  if (!isWhatsAppReady) {
    return res.status(502).json({
      status: "Fail",
      message: "WhatsApp client not ready. POST /reconnect first.",
      whatsappReady: false,
      pendingAlertCount: getPendingWhatsAppAlertCount(),
    });
  }
  const flush = await flushPendingWhatsAppAlerts();
  return res.status(200).json({
    status: "Success",
    whatsappReady: isWhatsAppReady,
    linkedBotPhone: getWhatsAppLinkedPhone(),
    pendingAlertCount: getPendingWhatsAppAlertCount(),
    flush,
  });
});

/** Resend linked agri load alert for a dispatch (by transportId or dispatch _id). */
router.post("/linked-agri/resend", async (req, res) => {
  const { transportId, dispatchId } = req.body || {};
  if (!transportId && !dispatchId) {
    return res.status(400).json({
      status: "Fail",
      message: "transportId or dispatchId required in body.",
    });
  }

  const query = dispatchId
    ? { _id: dispatchId }
    : { transportId: Number(transportId) || transportId };

  const dispatch = await Dispatch.findOne(query)
    .select("orderIds vehicleName vehicleNumber driverName driverMobile transportId")
    .lean();

  if (!dispatch) {
    return res.status(404).json({ status: "Fail", message: "Dispatch not found." });
  }

  const result = await sendLinkedAgriAlertForOrderIds(dispatch.orderIds || [], {
    vehicleName: dispatch.vehicleName,
    vehicleNumber: dispatch.vehicleNumber,
    driverName: dispatch.driverName,
    loadedBy: req.user?.name || req.user?.email || "System",
    actorPhone: req.user?.phoneNumber || "",
  });

  const ok = result.ok;
  return res.status(ok ? 200 : 502).json({
    status: ok ? "Success" : "Fail",
    message: ok
      ? `Linked agri alert sent (${result.pendingCount} pending order(s)).`
      : `Not sent: ${result.reason}`,
    whatsappReady: isWhatsAppReady,
    linkedBotPhone: getWhatsAppLinkedPhone(),
    pendingAlertCount: getPendingWhatsAppAlertCount(),
    result,
  });
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
