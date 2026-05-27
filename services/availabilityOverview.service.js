import { fetchAvailabilityOverviewData } from "./whatsappReportAvailability.service.js";

/**
 * Central report runner: slot availability overview (year-based filters).
 * Same data as GET /slots/availability-overview and WhatsApp availability reports.
 *
 * @param {string} [_startDate] Optional YYYY-MM-DD; year is taken from first 4 chars if options.year omitted
 * @param {string} [_endDate] Unused; kept for central report engine signature
 * @param {object} [options]
 * @param {number} [options.year]
 * @param {string} [options.month]
 * @param {string} [options.plantId]
 * @param {string} [options.search]
 * @param {boolean|string} [options.onlyAvailable]
 */
export async function fetchSlotAvailabilityReport(_startDate, _endDate, options = {}) {
  let year = options.year;
  if (year == null && _startDate && /^\d{4}/.test(String(_startDate))) {
    year = Number(String(_startDate).slice(0, 4));
  }
  if (year == null) {
    year = new Date().getFullYear();
  }

  const data = await fetchAvailabilityOverviewData({
    year: Number(year) || new Date().getFullYear(),
    month: options.month,
    plantId: options.plantId,
    search: options.search,
    onlyAvailable: options.onlyAvailable,
  });

  return { data };
}
