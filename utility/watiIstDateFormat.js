import moment from "moment";

/** India Standard Time — use for all farmer-facing WhatsApp template dates. */
export const WATI_IST_OFFSET_MINUTES = 330;

/**
 * Parse any stored order/API date as an IST calendar day (avoids UTC server showing previous day).
 * @param {Date|string|number|null|undefined} value
 * @returns {moment.Moment|null}
 */
export function momentInIst(value) {
  if (value == null || value === "") return null;
  const m = moment(value).utcOffset(WATI_IST_OFFSET_MINUTES);
  return m.isValid() ? m : null;
}

/** DD/MM/YYYY — order_accpeted_revamped {{delivery}}, payment reminder, etc. */
export function formatWatiDateDdMmYyyy(value, fallback = null) {
  const m = momentInIst(value);
  if (!m) return fallback;
  return m.format("DD/MM/YYYY");
}

/** en-IN style with explicit IST timezone (admin alert text). */
export function formatWatiDateEnIN(value, fallback = "—") {
  if (value == null || value === "") return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** delivery_final_second {{4}} — e.g. 28-May-2026 */
export function formatDeliveryFinalSecondDate(deliveryDate) {
  if (deliveryDate == null || deliveryDate === "") return "Soon";
  const m = momentInIst(deliveryDate);
  if (!m) return "Soon";
  return m.format("D-MMM-YYYY");
}

/** Farm-ready reschedule list labels — e.g. 28 May 2026 */
export function formatDeliveryDateLabelEn(value) {
  const m = momentInIst(value);
  if (!m) return "—";
  return m.format("DD MMMM YYYY");
}
