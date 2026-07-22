/**
 * Standard IST query date-range parsing for controllers and services.
 * Accepts YYYY-MM-DD (admin MIS) or DD-MM-YYYY (order list / insights).
 */
import { parseCalendarQueryBound } from "./istCalendar.js";
import { getIstTodayYmd, istDayBoundsFromYmd } from "./istOrderDateStats.js";

/** Parse inclusive IST bounds from query start/end strings. */
export function resolveIstQueryBounds(startDate, endDate) {
  if (startDate == null || startDate === "" || endDate == null || endDate === "") {
    return { error: "startDate and endDate are required" };
  }
  const rangeStart = parseCalendarQueryBound(startDate, false);
  const rangeEnd = parseCalendarQueryBound(endDate, true);
  if (!rangeStart || !rangeEnd) {
    return { error: "Invalid date format (use YYYY-MM-DD or DD-MM-YYYY)" };
  }
  if (rangeStart > rangeEnd) {
    return { error: "endDate must be on or after startDate" };
  }
  return { rangeStart, rangeEnd };
}

/** Start/end of today in IST (for dashboards, payment activity, etc.). */
export function istTodayBounds() {
  return istDayBoundsFromYmd(getIstTodayYmd());
}
