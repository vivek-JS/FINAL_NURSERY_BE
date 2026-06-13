import { parseCalendarQueryBound } from "./istCalendar.js";

/** Inclusive IST calendar-day range on dispatch `createdAt`. */
export function buildDispatchCreatedAtFilter(query = {}) {
  const start = parseCalendarQueryBound(query.startDate, false);
  const end = parseCalendarQueryBound(query.endDate, true);
  if (!start && !end) return null;
  const createdAt = {};
  if (start) createdAt.$gte = start;
  if (end) createdAt.$lte = end;
  return createdAt;
}
