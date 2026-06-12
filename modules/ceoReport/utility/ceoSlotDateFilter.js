import moment from "moment";

const FORMATS = ["DD-MM-YYYY", "D-M-YYYY", "DD/MM/YYYY"];

export function parseSlotDay(str) {
  if (!str) return null;
  const m = moment(String(str).trim(), FORMATS, true);
  return m.isValid() ? m.startOf("day") : null;
}

/** Slot window overlaps [rangeStart, rangeEnd] (Date objects). */
export function slotOverlapsRange(row, rangeStart, rangeEnd) {
  const start = parseSlotDay(row.startDay);
  const end = parseSlotDay(row.endDay);
  if (!start || !end) return true;
  const rs = moment(rangeStart).utcOffset(330).startOf("day");
  const re = moment(rangeEnd).utcOffset(330).endOf("day");
  return end.isSameOrAfter(rs, "day") && start.isSameOrBefore(re, "day");
}

export function filterRowsInRange(rows, rangeStart, rangeEnd) {
  return (rows || []).filter((r) => slotOverlapsRange(r, rangeStart, rangeEnd));
}

/** 'active' = today inside window, 'upcoming' = starts after today, 'past' = ended before today */
export function getSlotPhase(row, asOf = new Date()) {
  const start = parseSlotDay(row.startDay);
  const end = parseSlotDay(row.endDay);
  if (!start || !end) return "unknown";
  const today = moment(asOf).utcOffset(330).startOf("day");
  if (today.isBefore(start, "day")) return "upcoming";
  if (today.isAfter(end, "day")) return "past";
  return "active";
}

export function isSlotActiveToday(row, asOf = new Date()) {
  return getSlotPhase(row, asOf) === "active";
}
