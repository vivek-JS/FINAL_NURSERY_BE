/**
 * Report wizard (menu / PDFs) is restricted to these WhatsApp numbers (last 10 digits).
 * Override with env: WHATSAPP_REPORT_WIZARD_ALLOWLIST=7588686453,7588686452,...
 */

const DEFAULT_LAST10 = ["7588686453", "7588686452", "9595996452"];

export function getReportWizardAllowlistLast10() {
  const env = process.env.WHATSAPP_REPORT_WIZARD_ALLOWLIST;
  if (typeof env === "string" && env.trim()) {
    return env
      .split(/[\s,]+/)
      .map((s) => s.replace(/\D/g, "").slice(-10))
      .filter((s) => s.length === 10);
  }
  return [...DEFAULT_LAST10];
}

/** @param {string} [phoneOrWaId] - Any format; compares last 10 digits */
export function isPhoneAllowedForReportWizard(phoneOrWaId) {
  const digits = String(phoneOrWaId || "").replace(/\D/g, "");
  const last10 = digits.slice(-10);
  if (last10.length !== 10) {
    return false;
  }
  return getReportWizardAllowlistLast10().includes(last10);
}
