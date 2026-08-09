import AttendanceDaily from "../models/attendanceDaily.model.js";

const DAILY_TO_DAY_STATUS = {
  PRESENT: "PRESENT",
  LATE: "PRESENT",
  HALF_DAY: "HALF_DAY",
  ABSENT: "ABSENT",
  ON_LEAVE: "ABSENT",
  WEEKLY_OFF: "WEEKEND",
  HOLIDAY: "WEEKEND",
};

function pickEventImage(events, type) {
  const event = events?.find((e) => e.type === type);
  return event?.selfieUrl || null;
}

function pickEventTime(events, type) {
  const event = events?.find((e) => e.type === type);
  return event?.time || null;
}

/** Builds day rollup fields from AttendanceDaily + punch events (selfie fallback). */
export function enrichDayRollup(baseRollup, daily, events = []) {
  const checkInImageUrl = daily?.check_in?.audit_image_url || pickEventImage(events, "CHECK_IN");
  const checkOutImageUrl = daily?.check_out?.audit_image_url || pickEventImage(events, "CHECK_OUT");
  const checkInTime = daily?.check_in?.timestamp || pickEventTime(events, "CHECK_IN");
  const checkOutTime = daily?.check_out?.timestamp || pickEventTime(events, "CHECK_OUT");
  const isRegularized = daily?.status === "CORRECTED";
  const correctionNote = daily?.correction_reason || null;

  let status = baseRollup.status;
  let workingMinutes = baseRollup.workingMinutes;
  let isLate = baseRollup.isLate;

  if (isRegularized && daily?.attendance_status) {
    status = DAILY_TO_DAY_STATUS[daily.attendance_status] || status;
    if (typeof daily.total_working_minutes === "number") {
      workingMinutes = daily.total_working_minutes;
    }
    if (daily.attendance_status === "LATE") isLate = true;
  }

  return {
    ...baseRollup,
    status,
    workingMinutes,
    isLate,
    checkInTime: checkInTime ? new Date(checkInTime).toISOString() : null,
    checkOutTime: checkOutTime ? new Date(checkOutTime).toISOString() : null,
    checkInImageUrl,
    checkOutImageUrl,
    isRegularized,
    correctionNote,
  };
}

export async function fetchDailyByDate(employeeId, fromYmd, toYmd) {
  const rows = await AttendanceDaily.find({
    employee_id: employeeId,
    attendance_date: { $gte: fromYmd, $lte: toYmd },
  }).lean();

  const map = new Map();
  for (const row of rows) {
    map.set(row.attendance_date, row);
  }
  return map;
}

export function enrichTodaySummary(summary, daily, events = []) {
  if (!daily && !events.length) return summary;

  const enriched = enrichDayRollup(
    {
      date: summary.date,
      status: summary.isCheckedIn ? "PRESENT" : "ABSENT",
      workingMinutes: summary.workingMinutesSoFar,
      isLate: false,
    },
    daily,
    events
  );

  return {
    ...summary,
    check_in: daily?.check_in || summary.check_in || null,
    check_out: daily?.check_out || summary.check_out || null,
    isRegularized: enriched.isRegularized,
    correctionNote: enriched.correctionNote,
    checkInImageUrl: enriched.checkInImageUrl,
    checkOutImageUrl: enriched.checkOutImageUrl,
    checkInTime: enriched.checkInTime,
    checkOutTime: enriched.checkOutTime,
  };
}
