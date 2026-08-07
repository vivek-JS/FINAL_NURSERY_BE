import AttendanceRecord from "../models/attendanceRecord.model.js";
import { getIstTodayYmd } from "../utility/istCalendar.js";

const VALID_TYPES = ["CHECK_IN", "CHECK_OUT", "BREAK_START", "BREAK_END"];

/** Next allowed type(s) for each day-status — enforced server-side regardless of what the client suggests. */
const ALLOWED_NEXT_TYPES = {
  NOT_CHECKED_IN: ["CHECK_IN"],
  CHECKED_IN: ["CHECK_OUT", "BREAK_START"],
  ON_BREAK: ["BREAK_END"],
  CHECKED_OUT: [],
};

const NEXT_SUGGESTED_TYPE = {
  NOT_CHECKED_IN: "CHECK_IN",
  CHECKED_IN: "CHECK_OUT",
  ON_BREAK: "BREAK_END",
  CHECKED_OUT: "CHECK_IN",
};

export { VALID_TYPES };

export async function getTodayEvents(employeeId, dateYmd = getIstTodayYmd()) {
  return AttendanceRecord.find({ employee: employeeId, date: dateYmd }).sort({ time: 1 }).lean();
}

/** Derives the employee's current day-status purely from the last event's type. */
export function computeCurrentStatus(events) {
  if (!events.length) return "NOT_CHECKED_IN";
  const last = events[events.length - 1];
  switch (last.type) {
    case "CHECK_IN":
      return "CHECKED_IN";
    case "BREAK_START":
      return "ON_BREAK";
    case "BREAK_END":
      return "CHECKED_IN";
    case "CHECK_OUT":
      return "CHECKED_OUT";
    default:
      return "NOT_CHECKED_IN";
  }
}

export function getNextSuggestedType(status) {
  return NEXT_SUGGESTED_TYPE[status] || "CHECK_IN";
}

/** Returns { ok, reason } — server-side source of truth, independent of the client's suggested type. */
export function validateTransition(status, requestedType) {
  if (!VALID_TYPES.includes(requestedType)) {
    return { ok: false, reason: `Invalid attendance type "${requestedType}".` };
  }
  const allowed = ALLOWED_NEXT_TYPES[status] || [];
  if (!allowed.includes(requestedType)) {
    return { ok: false, reason: describeInvalidTransition(status, requestedType) };
  }
  return { ok: true };
}

function describeInvalidTransition(status, requestedType) {
  if (status === "CHECKED_OUT") return "You have already checked out for today.";
  if (requestedType === "CHECK_IN" && status !== "NOT_CHECKED_IN") return "You are already checked in today.";
  if (requestedType === "CHECK_OUT" && status === "ON_BREAK") return "Please end your break before checking out.";
  if (requestedType === "CHECK_OUT" && status === "NOT_CHECKED_IN") return "You need to check in before checking out.";
  if (requestedType === "BREAK_START" && status !== "CHECKED_IN") return "You can only start a break while checked in.";
  if (requestedType === "BREAK_END" && status !== "ON_BREAK") return "You are not currently on a break.";
  return "This action isn't allowed right now.";
}

/**
 * Sums working minutes for a day's events, treating BREAK_START..BREAK_END as
 * excluded time. If the employee is still checked in/on break (no closing
 * event yet), `openEndTime` (defaults to now) closes the open interval for
 * "so far today" totals — pass `null` to only count fully-closed intervals.
 */
export function computeWorkingMinutes(events, openEndTime = new Date()) {
  let totalMs = 0;
  let workStart = null;

  for (const event of events) {
    const time = new Date(event.time);
    if (event.type === "CHECK_IN" || event.type === "BREAK_END") {
      workStart = time;
    } else if ((event.type === "BREAK_START" || event.type === "CHECK_OUT") && workStart) {
      totalMs += time.getTime() - workStart.getTime();
      workStart = null;
    }
  }

  if (workStart && openEndTime) {
    totalMs += openEndTime.getTime() - workStart.getTime();
  }

  return Math.max(0, Math.round(totalMs / 60000));
}

export function buildTodaySummary(events, dateYmd = getIstTodayYmd()) {
  const status = computeCurrentStatus(events);
  return {
    date: dateYmd,
    events,
    nextSuggestedType: getNextSuggestedType(status),
    isCheckedIn: status === "CHECKED_IN" || status === "ON_BREAK",
    onBreak: status === "ON_BREAK",
    workingMinutesSoFar: computeWorkingMinutes(events),
  };
}
