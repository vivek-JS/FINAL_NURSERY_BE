import moment from "moment";

/** India Standard Time — use for all farmer-facing WhatsApp template dates. */
export const WATI_IST_OFFSET_MINUTES = 330;

/** Table / modal display — e.g. 15-June 2025 */
export const ORDER_DATE_DISPLAY_FORMAT = "D-MMMM YYYY";

/** WATI order accepted / dispatch template dates — e.g. 15-June-2026 */
export const WATI_TEMPLATE_DATE_FORMAT = "D-MMMM-YYYY";

/**
 * Parse any stored order/API date as an IST calendar day (avoids UTC server showing previous day).
 * @param {Date|string|number|null|undefined} value
 * @returns {moment.Moment|null}
 */
export function momentInIst(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const m = moment(s.slice(0, 10), "YYYY-MM-DD").utcOffset(WATI_IST_OFFSET_MINUTES, true);
    return m.isValid() ? m : null;
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

/** en-IN style with explicit IST timezone (admin alert text). */
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
