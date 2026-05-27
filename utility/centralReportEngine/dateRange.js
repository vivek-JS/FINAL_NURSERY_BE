/**
 * Central date-range rules for Admin MIS / central reports.
 * Future start and end dates are allowed (e.g. upcoming delivery planning).
 */

import { parseYmdRange, getIstTodayYmd } from "../istOrderDateStats.js";

/** MIS ranges may include future calendar days (not clamped to today). */
export const MIS_DATE_RANGE_POLICY = {
  allowFutureStart: true,
  allowFutureEnd: true,
};

/**
 * Parse YYYY-MM-DD start/end for central reports (IST day bounds + dateKeys).
 * @returns {ReturnType<typeof parseYmdRange>}
 */
export function parseCentralReportDateRange(startDate, endDate) {
  return parseYmdRange(startDate, endDate);
}

export { getIstTodayYmd, parseYmdRange };
