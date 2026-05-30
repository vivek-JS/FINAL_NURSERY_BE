/**
 * TEMP testing: allow resending WATI templates (accept / farm-ready / dispatch) and skip cron cooldown.
 * - WATI_WHATSAPP_UNLIMITED_SEND=true  → unlimited everywhere (cron + manual)
 * - WATI_WHATSAPP_UNLIMITED_SEND=false → block unless ?forceResend=1 on manual POST
 * - unset → manual ERP resend allowed; cron/auto still require env=true
 */

function parseForceResend(value) {
  return value === true || value === "true" || value === "1";
}

export function isWhatsappUnlimitedSendEnabled() {
  return process.env.WATI_WHATSAPP_UNLIMITED_SEND === "true";
}

/** Manual send from ERP (POST send-*-whatsapp). Temporarily defaults ON unless env=false. */
export function isWhatsappManualResendAllowed(req) {
  if (isWhatsappUnlimitedSendEnabled()) return true;
  if (parseForceResend(req?.query?.forceResend)) return true;
  return process.env.WATI_WHATSAPP_UNLIMITED_SEND !== "false";
}

/** Farm-ready template: skip 72h cooldown only for unlimited test or ?forceResend=1 */
export function isFarmReadyWhatsappCooldownBypassAllowed(req) {
  if (isWhatsappUnlimitedSendEnabled()) return true;
  return parseForceResend(req?.query?.forceResend);
}
