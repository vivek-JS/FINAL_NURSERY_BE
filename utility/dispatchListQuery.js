import { parseCalendarQueryBound } from "./istCalendar.js";

/** Trips that are finished — not part of the Loading list. */
export const CLOSED_TRANSPORT_STATUSES = ["DELIVERED", "CANCELLED"];

/**
 * Complete Orders fresh start. Vehicles created before this instant stay on the Old tab.
 * New is empty until a vehicle is created on or after this time. Stored rows are not changed.
 * 9 Nov 2026, 10:10 IST.
 */
export const DISPATCH_LEDGER_CUTOVER = new Date("2026-11-09T04:40:00.000Z");

/**
 * AND another `_id` constraint onto a dispatch filter.
 * Search already sets `_id: { $in }`; completed-trip exclusion is `$nin`.
 */
export function constrainDispatchIds(filter, constraint) {
  if (!constraint) return filter;
  if (!filter._id) {
    filter._id = constraint;
    return filter;
  }
  filter.$and = [...(filter.$and || []), { _id: filter._id }, { _id: constraint }];
  delete filter._id;
  return filter;
}

/**
 * Inclusive IST calendar-day range on dispatch `createdAt`,
 * combined with `ledger=new|old` around DISPATCH_LEDGER_CUTOVER.
 */
export function buildDispatchCreatedAtFilter(query = {}) {
  const start = parseCalendarQueryBound(query.startDate, false);
  const end = parseCalendarQueryBound(query.endDate, true);
  const createdAt = {};
  if (start) createdAt.$gte = start;
  if (end) createdAt.$lte = end;

  const ledger = String(query.ledger || "").trim().toLowerCase();
  if (ledger === "new" || ledger === "old") {
    const cut = DISPATCH_LEDGER_CUTOVER;
    if (ledger === "new") {
      if (!createdAt.$gte || createdAt.$gte < cut) createdAt.$gte = cut;
    } else if (!(createdAt.$lte && createdAt.$lte < cut)) {
      delete createdAt.$lte;
      createdAt.$lt = cut;
    }
  }

  if (createdAt.$gte == null && createdAt.$lte == null && createdAt.$lt == null) return null;
  return createdAt;
}
