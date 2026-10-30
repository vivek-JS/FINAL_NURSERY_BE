/**
 * WhatsApp linked-device connection (QR scan) — SUPER_ADMIN only: the QR grants full account access.
 *
 * GET  /api/v1/whatsapp-connection/status        state + live QR (keeps QR refreshing while polled)
 * POST /api/v1/whatsapp-connection/connect       start / reconnect
 * POST /api/v1/whatsapp-connection/pairing-code  { phone } → 8-char code (link without camera)
 * POST /api/v1/whatsapp-connection/test          { to?, message? } → admins when `to` omitted
 * POST /api/v1/whatsapp-connection/logout        unlink + wipe login + fresh QR
 */
import express from "express";
import {
  ensureWhatsAppConnected,
  getWhatsAppConnectionStatus,
  isWhatsAppReady,
  keepWhatsAppQrAlive,
  requestWhatsAppPairingCode,
  resetWhatsAppSessionForRelink,
  sendWhatsAppText,
} from "../services/whatsapp/index.js";
import {
  getAdminNumbersFromEnv,
  getPendingWhatsAppAlertCount,
} from "../services/whatsappAlertService.js";

const router = express.Router();

const buildStatus = () => ({
  ...getWhatsAppConnectionStatus({ includeQr: true }),
  alertsEnabled: process.env.WHATSAPP_ALERTS_ENABLED === "true",
  orderFlowEnabled: process.env.WHATSAPP_ORDER_FLOW_ENABLED === "true",
  adminNumberCount: getAdminNumbersFromEnv().length,
  pendingAlertCount: getPendingWhatsAppAlertCount(),
});

const fail = (res, code, message) => res.status(code).json({ status: "Fail", message });

router.get("/status", (req, res) => {
  if (req.query?.watch === "1") keepWhatsAppQrAlive();
  return res.status(200).json({ status: "Success", data: buildStatus() });
});

router.post("/connect", async (_req, res) => {
  const result = await ensureWhatsAppConnected("erp-connection-page", {
    wantQr: true,
    force: true,
    timeoutMs: 8000,
  });
  return res.status(200).json({ status: "Success", data: { ...buildStatus(), result } });
});

router.post("/pairing-code", async (req, res) => {
  try {
    const code = await requestWhatsAppPairingCode(req.body?.phone);
    return res.status(200).json({ status: "Success", data: { code } });
  } catch (err) {
    return fail(res, 400, err?.message || "Could not create pairing code");
  }
});

router.post("/test", async (req, res) => {
  if (!isWhatsAppReady) return fail(res, 409, "WhatsApp is not connected");
  const targets = req.body?.to ? [String(req.body.to)] : getAdminNumbersFromEnv();
  if (!targets.length) return fail(res, 400, "No number given and WHATSAPP_ADMIN_NUMBERS is empty");

  const message =
    String(req.body?.message || "").trim() ||
    `✅ ERP WhatsApp test — ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
  const results = await Promise.all(
    targets.map((to) =>
      sendWhatsAppText(to, message).catch((err) => ({ ok: false, reason: err?.message || String(err) }))
    )
  );
  const sent = results.filter((r) => r.ok).length;
  return res.status(sent ? 200 : 502).json({
    status: sent ? "Success" : "Fail",
    message: `Sent ${sent}/${targets.length}`,
    data: { results },
  });
});

router.post("/logout", async (_req, res) => {
  try {
    await resetWhatsAppSessionForRelink("erp-connection-page");
    return res.status(200).json({ status: "Success", data: buildStatus() });
  } catch (err) {
    return fail(res, 500, err?.message || "Logout failed");
  }
});

export default router;
