import moment from "moment";

/** India Standard Time — use for all farmer-facing WhatsApp template dates. */
export const WATI_IST_OFFSET_MINUTES = 330;

/** Table / modal display — e.g. 15-June 2025 */
export const ORDER_DATE_DISPLAY_FORMAT = "D-MMMM YYYY";

/** WATI order accepted / dispatch template dates — e.g. 15-June-2026 */
export const WATI_TEMPLATE_DATE_FORMAT = "D-MMMM-YYYY";

/** Instant → IST (matches slot windows and deliveryDate storage at IST midnight). */
function momentFromStoredInstant(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return moment(d).utcOffset(WATI_IST_OFFSET_MINUTES);
}

/**
 * Parse stored order/API dates as an IST calendar day.
 * ISO datetimes use the true IST offset (e.g. 2026-06-10T18:30:00Z → 11 Jun IST).
 * @param {Date|string|number|null|undefined} value
 * @returns {moment.Moment|null}
 */
export function momentInIst(value) {
  if (value == null || value === "") return null;

  if (value instanceof Date) {
    return momentFromStoredInstant(value);
  }

  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const m = moment(s, "YYYY-MM-DD").utcOffset(WATI_IST_OFFSET_MINUTES, true);
    return m.isValid() ? m : null;
  }
  if (/^\d{4}-\d{2}-\d{2}[Tt]/.test(s)) {
    return momentFromStoredInstant(s);
  }
  if (/^\d{2}-\d{2}-\d{4}/.test(s)) {
    const m = moment(s.slice(0, 10), "DD-MM-YYYY").utcOffset(WATI_IST_OFFSET_MINUTES, true);
    return m.isValid() ? m : null;
  }

  const m = moment(value).utcOffset(WATI_IST_OFFSET_MINUTES);
  return m.isValid() ? m : null;
}

/** WATI order_accpeted_revamped {{delivery}}, payment reminder, etc. — e.g. 15-June-2026 */
export function formatWatiDateDdMmYyyy(value, fallback = null) {
  const m = momentInIst(value);
  if (!m) return fallback;
  return m.format(WATI_TEMPLATE_DATE_FORMAT);
}

/** en-IN style (admin alert text). */
export function formatWatiDateEnIN(value, fallback = "—") {
  const m = momentInIst(value);
  if (!m) return fallback;
  return m.format("DD/MM/YYYY");
}

/** delivery_final_second {{4}} delivery date — e.g. 15-June-2026 */
export function formatDeliveryFinalSecondDate(deliveryDate) {
  if (deliveryDate == null || deliveryDate === "") return "Soon";
  const m = momentInIst(deliveryDate);
  if (!m) return "Soon";
  return m.format(WATI_TEMPLATE_DATE_FORMAT);
}

/** Farm-ready reschedule list labels — e.g. 15 June 2026 */
export function formatDeliveryDateLabelEn(value) {
  const m = momentInIst(value);
  if (!m) return "—";
  return m.format("D MMMM YYYY");
}
