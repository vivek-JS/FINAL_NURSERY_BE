import moment from "moment";
import AttendanceRecord from "../models/attendanceRecord.model.js";
import AttendanceDaily from "../models/attendanceDaily.model.js";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import { getIstTodayYmd } from "../utility/istCalendar.js";
import { getTodayEvents, buildTodaySummary, computeWorkingMinutes } from "../services/attendanceSequence.service.js";
import {
  enrichDayRollup,
  enrichTodaySummary,
  fetchDailyByDate,
} from "../services/attendanceDashboardMerge.service.js";

const FULL_DAY_MINUTES = 360; // >=6h counted as a full present day
const YMD_RE = /^\d{4}-\d{2}$/;

function resolveTargetMonth(monthParam, todayYmd) {
  if (monthParam && YMD_RE.test(monthParam)) {
    const [y, m] = monthParam.split("-").map(Number);
    return { year: y, month: m };
  }
  const [y, m] = todayYmd.split("-").map(Number);
  return { year: y, month: m };
}

/** Classifies a single calendar day from its attendance events. */
function classifyDay(dateYmd, events, todayYmd) {
  const dow = moment(dateYmd, "YYYY-MM-DD").day(); // 0 = Sunday
  if (dow === 0) {
    return { date: dateYmd, status: "WEEKEND", workingMinutes: 0, isLate: false };
  }

  if (!events.length) {
    return { date: dateYmd, status: "ABSENT", workingMinutes: 0, isLate: false };
  }

  const openEndTime = dateYmd === todayYmd ? new Date() : null;
  const workingMinutes = computeWorkingMinutes(events, openEndTime);
  const isLate = events.some((e) => e.type === "CHECK_IN" && e.isLate);
  const status = workingMinutes >= FULL_DAY_MINUTES ? "PRESENT" : "HALF_DAY";

  return { date: dateYmd, status, workingMinutes, isLate };
}

/**
 * GET /api/v1/face-attendance/dashboard?month=YYYY-MM (optional, defaults to current month)
 * Returns today's live status plus a day-by-day breakdown of the requested
 * month (only through today, so future days aren't marked absent) and
 * month-level aggregates for the dashboard's stat cards.
 */
export const getDashboard = catchAsync(async (req, res) => {
  const employeeId = req.user._id;
  const todayYmd = getIstTodayYmd();
  const { year, month } = resolveTargetMonth(req.query.month, todayYmd);

  const monthStart = moment(`${year}-${String(month).padStart(2, "0")}-01`, "YYYY-MM-DD").utcOffset(330, true);
  const monthStartYmd = monthStart.format("YYYY-MM-DD");
  const monthEndYmd = monthStart.clone().endOf("month").format("YYYY-MM-DD");

  const [todayEvents, monthRecords, todayDaily, dailyByDate] = await Promise.all([
    getTodayEvents(employeeId, todayYmd),
    AttendanceRecord.find({
      employee: employeeId,
      date: { $gte: monthStartYmd, $lte: monthEndYmd },
    })
      .sort({ time: 1 })
      .lean(),
    AttendanceDaily.findOne({ employee_id: employeeId, attendance_date: todayYmd }).lean(),
    fetchDailyByDate(employeeId, monthStartYmd, monthEndYmd),
  ]);

  const eventsByDate = new Map();
  for (const record of monthRecords) {
    if (!eventsByDate.has(record.date)) eventsByDate.set(record.date, []);
    eventsByDate.get(record.date).push(record);
  }

  const days = [];
  const cursor = monthStart.clone();
  const lastDateToInclude = monthEndYmd < todayYmd ? monthEndYmd : todayYmd;
  while (cursor.format("YYYY-MM-DD") <= lastDateToInclude) {
    const dateYmd = cursor.format("YYYY-MM-DD");
    const events = eventsByDate.get(dateYmd) || [];
    const base = classifyDay(dateYmd, events, todayYmd);
    days.push(enrichDayRollup(base, dailyByDate.get(dateYmd), events));
    cursor.add(1, "day");
  }

  const totalWorkingMinutes = days.reduce((sum, d) => sum + d.workingMinutes, 0);
  const lateCountThisMonth = days.filter((d) => d.isLate).length;
  const leavesThisMonth = days.filter((d) => d.status === "ABSENT").length;
  const presentDaysThisMonth = days.filter((d) => d.status === "PRESENT" || d.status === "HALF_DAY").length;

  const summary = {
    today: enrichTodaySummary(buildTodaySummary(todayEvents, todayYmd), todayDaily, todayEvents),
    last30Days: days,
    totalWorkingHoursThisMonth: Math.round((totalWorkingMinutes / 60) * 10) / 10,
    lateCountThisMonth,
    leavesThisMonth,
    presentDaysThisMonth,
  };

  return res.status(200).json(generateResponse("Success", "Dashboard summary fetched successfully", summary, undefined));
});
