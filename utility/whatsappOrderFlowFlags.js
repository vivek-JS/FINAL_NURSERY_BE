/**
 * Temporarily turn off the WhatsApp **order bot** conversation (`processOrderFlow`).
 * Interactive report wizard runs on the same webhooks. Optional legacy one-shot
 * PDF: set `WHATSAPP_LEGACY_INSTANT_BOOKING_PDF=true` (old "today booking" instant PDF).
 *
 * Set on server: DISABLE_WHATSAPP_ORDER_FLOW=true
 * Alternative: WHATSAPP_ORDER_FLOW_ENABLED=false
 */
export function isWhatsappOrderFlowDisabled() {
  return (
    process.env.DISABLE_WHATSAPP_ORDER_FLOW === "true" ||
    process.env.WHATSAPP_ORDER_FLOW_ENABLED === "false"
  );
}
