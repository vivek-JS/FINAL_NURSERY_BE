/**
 * TEMP testing: allow resending WATI templates (accept / farm-ready / dispatch) and skip cron cooldown.
 * Set WATI_WHATSAPP_UNLIMITED_SEND=true — disable before production go-live.
 */
export function isWhatsappUnlimitedSendEnabled() {
  return process.env.WATI_WHATSAPP_UNLIMITED_SEND === "true";
}
