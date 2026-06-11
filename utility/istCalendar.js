/**
 * Single entry point for IST calendar-day logic (slots, orders, admin MIS, WATI).
 * All farmer-facing dates must go through these helpers — never raw UTC midnight.
 */
import moment from "moment";
import { parseOrderListDateDdMmYyyy } from "./orderListQuery.js";
import {
  istDayBoundsFromYmd,
  parseYmdRange,
} from "./istOrderDateStats.js";
import { deliveryDateToIstMoment } from "./istSlotDate.js";

export {
  IST_TIMEZONE,
  ORDER_EXCLUDED_STATUSES,
  LINE_PLANT_TOTAL_ADD_FIELDS,
  istDayBoundsFromYmd,
  getIstTodayYmd,
  getIstYesterdayYmd,
  generateIstDateKeys,
  parseYmdRange,
  orderStatusExcludeMatch,
  istDateStringExpr,
} from "./istOrderDateStats.js";

export {
  IST_OFFSET,
  slotDayStartMoment,
  slotDayEndMoment,
  deliveryDateToIstMoment,
  isDateOutsideSlotWindow,
  isDeliveryDateInSlotWindow,
  slotWindowToDeliveryUtcRange,
} from "./istSlotDate.js";

export { parseOrderListDateDdMmYyyy };
export { momentInIst } from "./watiIstDateFormat.js";

const API_YMD = "YYYY-MM-DD";

/** Body fields stored as IST calendar-day instants (order create/update). */
export const BODY_IST_CALENDAR_KEYS = ["deliveryDate", "dispatchTargetDate"];

/** Query pairs interpreted as inclusive IST calendar-day ranges. */
export const QUERY_IST_RANGE_PAIRS = [
  ["startDate", "endDate"],
  ["fromDate", "toDate"],
  ["dateFrom", "dateTo"],
];

/**
 * Parse a calendar query value into IST start or end of day.
 * Supports YYYY-MM-DD (admin MIS), DD-MM-YYYY (order list), and ISO datetimes.
 */
export function parseCalendarQueryBound(value, isEnd = false) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const { start, end } = istDayBoundsFromYmd(s);
    return isEnd ? end : start;
  }
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
    return parseOrderListDateDdMmYyyy(s, isEnd);
  }
  const m = deliveryDateToIstMoment(s);
  if (!m) return null;
  return isEnd ? m.clone().endOf("day").toDate() : m.clone().startOf("day").toDate();
}

/** IST YYYY-MM-DD key for comparisons and API params. */
export function formatIstYmd(value) {
  const m = deliveryDateToIstMoment(value);
  return m ? m.format(API_YMD) : "";
}

/**
 * Normalize client delivery / dispatch calendar input → Date at IST start-of-day.
 * e.g. picker "11 Jun" or 2026-06-10T18:30:00Z → same IST midnight instant.
 */
export function normalizeDeliveryDateForStorage(value) {
  const m = deliveryDateToIstMoment(value);
  if (!m) return null;
  return m.clone().startOf("day").toDate();
}

/** IST bounds for a calendar year. */
export function istYearBounds(year) {
  const y = Number(year);
  if (!Number.isFinite(y)) return null;
  return {
    start: istDayBoundsFromYmd(`${y}-01-01`).start,
    end: istDayBoundsFromYmd(`${y}-12-31`).end,
  };
}

/** IST bounds for a calendar month (1–12). */
export function istMonthBounds(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const start = istDayBoundsFromYmd(`${y}-${pad(m)}-01`).start;
  const lastDay = moment(`${y}-${pad(m)}-01`, API_YMD)
    .utcOffset(330, true)
    .endOf("month")
    .date();
  const end = istDayBoundsFromYmd(`${y}-${pad(m)}-${pad(lastDay)}`).end;
  return { start, end };
}

/**
 * Normalize known body calendar fields in place (mutates target).
 * @returns {string[]} keys that were normalized
 */
export function normalizeBodyIstCalendarDates(target, keys = BODY_IST_CALENDAR_KEYS) {
  if (!target || typeof target !== "object") return [];
  const changed = [];
  for (const key of keys) {
    if (target[key] == null || target[key] === "") continue;
    const normalized = normalizeDeliveryDateForStorage(target[key]);
    if (normalized) {
      target[key] = normalized;
      changed.push(key);
    }
  }
  return changed;
}

/**
 * Parse common start/end query pairs into IST Mongo bounds.
 * DD-MM-YYYY → rangeStart/rangeEnd; YYYY-MM-DD → parseYmdRange result.
 */
export function parseQueryIstDateRange(query, pairs = QUERY_IST_RANGE_PAIRS) {
  if (!query || typeof query !== "object") return null;
  for (const [startKey, endKey] of pairs) {
    const startRaw = query[startKey];
    const endRaw = query[endKey];
    if (!startRaw || !endRaw) continue;

    const startStr = String(startRaw).trim();
    const endStr = String(endRaw).trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(startStr) && /^\d{4}-\d{2}-\d{2}$/.test(endStr)) {
      const parsed = parseYmdRange(startStr, endStr);
      if (!parsed.error) {
        return { ...parsed, startKey, endKey, format: "ymd" };
      }
    }

    const rangeStart = parseCalendarQueryBound(startStr, false);
    const rangeEnd = parseCalendarQueryBound(endStr, true);
    if (rangeStart && rangeEnd) {
      return {
        startKey,
        endKey,
        format: "dd-mm-yyyy",
        rangeStart,
        rangeEnd,
        startYmd: formatIstYmd(rangeStart),
        endYmd: formatIstYmd(rangeEnd),
      };
    }
  }
  return null;
}
