/**
 * WhatsApp linked-device (QR scan) public API — Baileys, no browser.
 * WATI (official business API) is separate: services/watiService.js.
 */
import {
  getWhatsAppConnectionStatus,
  isWhatsAppReady,
  requestWhatsAppQr,
  startWhatsAppClient as startConnection,
} from "./connection.js";
import { attachWhatsAppRouters } from "./inboundRouter.js";

export {
  isWhatsAppReady,
  shutdownWhatsAppClient,
  ensureWhatsAppConnected,
  waitUntilWhatsAppReady,
  isWhatsAppConnectionInProgress,
  getWhatsAppLinkedPhone,
  getWhatsAppConnectionStatus,
  hasSavedWhatsAppSession,
  requestWhatsAppQr,
  requestWhatsAppPairingCode,
  resetWhatsAppSessionForRelink,
  reportWhatsAppTransportFailure,
  isWhatsAppConnectionError,
} from "./connection.js";

export {
  sendWhatsAppText,
  sendWhatsAppMedia,
  isWhatsAppNumberRegistered,
  toUserJid,
} from "./transport.js";

export function startWhatsAppClient(options) {
  attachWhatsAppRouters();
  return startConnection(options);
}

const BRIDGE_STATUS = {
  connected: "connected",
  qr: "qr_required",
  connecting: "connecting",
  reconnecting: "reconnecting",
  logged_out: "logged_out",
};

/** Status shape consumed by the whatsapp-automation campaign app (erpWhatsAppBridge.ts). */
export function getWhatsAppBridgePublicStatus() {
  const s = getWhatsAppConnectionStatus({ includeQr: true });
  return {
    status: BRIDGE_STATUS[s.status] || "disconnected",
    whatsappReady: isWhatsAppReady,
    linkedPhone: s.linkedPhone,
    sessionPersisted: s.sessionSaved,
    authPending: s.status === "connecting" && s.sessionSaved,
    qrHint: null,
    qrPayload: s.qr || null,
    lastQrAt: s.qrAt ? new Date(s.qrAt).toISOString() : null,
    qrExpired: !isWhatsAppReady && s.status === "needs_scan",
  };
}

/** Keep QR codes coming while a viewer polls; no-op once linked. */
export function keepWhatsAppQrAlive() {
  if (!isWhatsAppReady) void requestWhatsAppQr();
}
