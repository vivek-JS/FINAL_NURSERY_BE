import { IST_OFFSET_MS } from "../utility/attendanceEventTime.js";
import { getIstTodayYmd } from "../utility/istCalendar.js";

/** Returns ISO weekday 0=Sun .. 6=Sat for an IST calendar date string. */
export function getIstWeekday(dateYmd) {
  const [y, m, d] = dateYmd.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d, 12, 0, 0);
  const ist = new Date(utc - IST_OFFSET_MS);
  return ist.getUTCDay();
}

function parseHHmmToMinutes(hhmm) {
  if (!hhmm) return null;
  const [hh, mm] = hhmm.split(":").map(Number);
  return hh * 60 + mm;
}

function pickStartTime(cfg) {
  return cfg?.officeStartTime || cfg?.shiftStartTime || null;
}

function pickEndTime(cfg) {
  return cfg?.officeEndTime || cfg?.shiftEndTime || null;
}

/**
 * Resolve effective office hours for an employee.
 * Priority: per-user override → officeGroup → department → defaults.
 *
 * @param {object} user — User doc (may populate officeGroup, department)
 * @returns {{ officeStartTime, officeEndTime, lateGraceMinutes, weeklyOffDays, minMinutesBetweenCheckInAndOut, source }}
 */
export function resolveOfficeHours(user) {
  const group = user?.officeGroup && typeof user.officeGroup === "object" ? user.officeGroup : null;
  const dept = user?.department && typeof user.department === "object" ? user.department : null;
  const base = group || dept || {};

  const officeStartTime =
    user?.officeStartTimeOverride ||
    pickStartTime(group) ||
    pickStartTime(dept) ||
    "09:30";
  const officeEndTime =
    user?.officeEndTimeOverride ||
    pickEndTime(group) ||
    pickEndTime(dept) ||
    "18:00";

  return {
    officeStartTime,
    officeEndTime,
    shiftStartTime: officeStartTime,
    shiftEndTime: officeEndTime,
    lateGraceMinutes: base.lateGraceMinutes ?? 10,
    weeklyOffDays: base.weeklyOffDays || [],
    minMinutesBetweenCheckInAndOut: base.minMinutesBetweenCheckInAndOut ?? 30,
    source: group ? "office_group" : dept ? "department" : "default",
    office_group_id: group?._id || user?.officeGroup || null,
  };
}

function eventIstMinutes(eventTime) {
  const istMs = eventTime.getTime() + IST_OFFSET_MS;
  const istDate = new Date(istMs);
  return istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
}

export function isWeeklyOff(department, dateYmd) {
  const offDays = department?.weeklyOffDays || [];
  if (!offDays.length) return false;
  return offDays.includes(getIstWeekday(dateYmd));
}

/** Simple env-based holiday list: ATTENDANCE_HOLIDAYS=2026-01-26,2026-08-15 */
export function isHoliday(dateYmd) {
  const raw = process.env.ATTENDANCE_HOLIDAYS || "";
  const holidays = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return holidays.includes(dateYmd);
}

export function validateShiftTiming(officeHours, eventTime, attendanceType) {
  if (!officeHours) return { ok: true };

  const dateYmd = getIstTodayYmd();
  if (isHoliday(dateYmd)) {
    return { ok: false, errorCode: "OUTSIDE_SHIFT_TIME", message: "Today is a holiday." };
  }
  if (isWeeklyOff(officeHours, dateYmd)) {
    return { ok: false, errorCode: "OUTSIDE_SHIFT_TIME", message: "Today is a weekly off day." };
  }

  const eventMinutes = eventIstMinutes(eventTime);
  const shiftStart = parseHHmmToMinutes(pickStartTime(officeHours));
  const shiftEnd = parseHHmmToMinutes(pickEndTime(officeHours));

  if (attendanceType === "CHECK_IN" && shiftStart != null) {
    const earliest = shiftStart - 120;
    const latest = shiftEnd != null ? shiftEnd : shiftStart + 720;
    if (eventMinutes < earliest || eventMinutes > latest) {
      return { ok: false, errorCode: "OUTSIDE_SHIFT_TIME", message: "Check-in is outside allowed shift hours." };
    }
  }

  return { ok: true };
}

export function computeLateByMinutes(checkInTime, officeHours) {
  const startTime = pickStartTime(officeHours);
  if (!startTime) return 0;
  const shiftStart = parseHHmmToMinutes(startTime);
  const grace = Number.isFinite(officeHours?.lateGraceMinutes) ? officeHours.lateGraceMinutes : 10;
  const checkInMinutes = eventIstMinutes(checkInTime);
  const diff = checkInMinutes - (shiftStart + grace);
  return diff > 0 ? diff : 0;
}

export function computeEarlyExitMinutes(checkOutTime, officeHours) {
  const endTime = pickEndTime(officeHours);
  if (!endTime) return 0;
  const shiftEnd = parseHHmmToMinutes(endTime);
  const checkOutMinutes = eventIstMinutes(checkOutTime);
  const diff = shiftEnd - checkOutMinutes;
  return diff > 0 ? diff : 0;
}

export function deriveAttendanceStatus({ checkInTime, checkOutTime, department, lateByMinutes, earlyExitMinutes }) {
  if (!checkInTime) return "ABSENT";
  if (lateByMinutes > 0) return "LATE";
  if (earlyExitMinutes > 0 && checkOutTime) return "HALF_DAY";
  if (checkInTime && checkOutTime) return "PRESENT";
  return "PRESENT";
}

export function validateMinCheckoutGap(checkInTime, checkOutTime, officeHours) {
  const minGap = officeHours?.minMinutesBetweenCheckInAndOut ?? Number(process.env.MIN_MINUTES_BETWEEN_CHECKIN_CHECKOUT) ?? 30;
  if (!checkInTime || !checkOutTime) return { ok: true };
  const diffMs = checkOutTime.getTime() - checkInTime.getTime();
  const diffMin = diffMs / 60000;
  if (diffMin < minGap) {
    return {
      ok: false,
      errorCode: "CHECK_OUT_ALREADY_MARKED",
      message: `Minimum ${minGap} minutes required between check-in and check-out.`,
    };
  }
  return { ok: true };
}
