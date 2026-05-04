/**
 * WhatsApp **order bot** (plant list / banana–chili style ordering) is **off by default**.
 * Reports wizard handles inbound messages instead.
 *
 * Opt in to the legacy order conversation: `WHATSAPP_ORDER_FLOW_ENABLED=true`
 * Force off regardless: `DISABLE_WHATSAPP_ORDER_FLOW=true`
 *
 * Legacy one-shot booking PDF: `WHATSAPP_LEGACY_INSTANT_BOOKING_PDF=true`
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
