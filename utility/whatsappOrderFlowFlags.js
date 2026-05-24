/**
 * WhatsApp order bot configuration.
 *
 * Enable flow: `WHATSAPP_ORDER_FLOW_ENABLED=true`
 * Disable: `DISABLE_WHATSAPP_ORDER_FLOW=true`
 *
 * Dual channel (default when flow is on): farmers can message via
 *   • scanned QR / whatsapp-web.js (same session as alerts)
 *   • WATI webhook → `/api/v1/whatsapp-order/webhook`
 *
 * Opt out of one channel:
 *   DISABLE_WHATSAPP_ORDER_WEBJS=true
 *   DISABLE_WHATSAPP_ORDER_WATI=true
 *
 * Optional fallback if primary send fails:
 *   WHATSAPP_ORDER_FALLBACK_WEBJS=true
 *   WHATSAPP_ORDER_FALLBACK_WATI=true
 */

export function isWhatsappOrderFlowDisabled() {
  if (process.env.DISABLE_WHATSAPP_ORDER_FLOW === "true") {
    return true;
  }
  if (process.env.WHATSAPP_ORDER_FLOW_ENABLED === "true") {
    return false;
  }
  return true;
}

/** Scanned WhatsApp session (whatsapp-web.js). */
export function isWhatsappOrderWebJsEnabled() {
  if (process.env.DISABLE_WHATSAPP_ORDER_WEBJS === "true") {
    return false;
  }
  return true;
}

/** WATI API webhook + sendSessionMessage. */
export function isWhatsappOrderWatiEnabled() {
  if (process.env.DISABLE_WHATSAPP_ORDER_WATI === "true") {
    return false;
  }
  return true;
}

export function isWhatsappOrderDualChannel() {
  return isWhatsappOrderWebJsEnabled() && isWhatsappOrderWatiEnabled();
}

/** @deprecated Use isWhatsappOrderWebJsEnabled */
export function isWhatsappOrderViaWebJs() {
  return isWhatsappOrderWebJsEnabled();
}
