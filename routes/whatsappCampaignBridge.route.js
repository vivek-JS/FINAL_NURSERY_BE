/**
 * Internal API for whatsapp-automation app (same server).
 * Uses ERP whatsapp-web.js session — no second QR scan.
 */
import express from "express";
import {
  sendCampaignOutbound,
  checkWhatsAppRegistered,
  getCampaignBridgeStatus,
} from "../services/whatsappCampaignBridge.service.js";
import {
  isWhatsAppConnectionInProgress,
  getWhatsAppBridgePublicStatus,
  startWhatsAppClient,
  ensureWhatsAppConnected,
  resetWhatsAppSessionForRelink,
} from "../services/whatsappClient.js";

const router = express.Router();

function requireInternalKey(req, res, next) {
  const expected = process.env.WA_CAMPAIGN_INTERNAL_KEY || "";
  if (!expected) {
    return res.status(503).json({ error: "WA_CAMPAIGN_INTERNAL_KEY not configured on ERP" });
  }
  const key = req.headers["x-wa-campaign-key"];
  if (key !== expected) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

router.use(requireInternalKey);

router.get("/status", (_req, res) => {
  const pub = getWhatsAppBridgePublicStatus();
  if (!pub.whatsappReady && !pub.qrPayload && !isWhatsAppConnectionInProgress()) {
    void startWhatsAppClient().catch(() => {});
  }
  return res.json({
    mode: "erp",
    ...pub,
    ...getCampaignBridgeStatus(),
  });
});

router.post("/send", async (req, res) => {
  const { mobile, text, attachmentPath, attachmentMime } = req.body || {};
  if (!mobile) {
    return res.status(400).json({ error: "mobile required" });
  }
  const result = await sendCampaignOutbound({
    mobile,
    text: text || "",
    attachmentPath,
    attachmentMime,
  });
  return res.status(result.ok ? 200 : 502).json(result);
});

router.post("/reconnect", async (_req, res) => {
  const result = await ensureWhatsAppConnected("campaign-bridge");
  return res.status(result.ok ? 200 : 502).json(result);
});

router.post("/reset-session", async (_req, res) => {
  const result = await resetWhatsAppSessionForRelink("campaign-bridge-reset");
  return res.status(result.ok ? 200 : 502).json(result);
});

router.get("/registered", async (req, res) => {
  const mobile = req.query.mobile;
  if (!mobile) return res.status(400).json({ error: "mobile query required" });
  const result = await checkWhatsAppRegistered(String(mobile));
  return res.json(result);
});

export default router;
