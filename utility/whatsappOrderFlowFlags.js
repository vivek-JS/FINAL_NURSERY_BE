/**
 * WhatsApp order bot configuration.
 *
 * Enable flow: `WHATSAPP_ORDER_FLOW_ENABLED=true`
 * Disable: `DISABLE_WHATSAPP_ORDER_FLOW=true`
 *
 * Channel (default = scanned QR / whatsapp-web.js, same as admin alerts):
 *   WHATSAPP_ORDER_USE_WATI=true  → inbound/outbound via WATI webhook only
 *   (unset or false)             → inbound/outbound via whatsapp-web.js session
 */

export function isWhatsappOrderViaWebJs() {
  return process.env.WHATSAPP_ORDER_USE_WATI !== "true";
}

export function isWhatsappOrderFlowDisabled() {
  if (process.env.DISABLE_WHATSAPP_ORDER_FLOW === "true") {
    return true;
  }
  if (process.env.WHATSAPP_ORDER_FLOW_ENABLED === "true") {
    return false;
  }
  return true;
}
