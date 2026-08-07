import AttendanceRecord from "../models/attendanceRecord.model.js";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import { getIstTodayYmd } from "../utility/istCalendar.js";
import { getTodayEvents, buildTodaySummary } from "../services/attendanceSequence.service.js";

/** GET /api/v1/face-attendance/today */
export const getToday = catchAsync(async (req, res) => {
  const dateYmd = getIstTodayYmd();
  const events = await getTodayEvents(req.user._id, dateYmd);
  const summary = buildTodaySummary(events, dateYmd);

  return res.status(200).json(generateResponse("Success", "Today's attendance fetched successfully", summary, undefined));
});

/** GET /api/v1/face-attendance/history?from=YYYY-MM-DD&to=YYYY-MM-DD&page=&limit= */
export const getHistory = catchAsync(async (req, res) => {
  const { from, to, page = 1, limit = 30 } = req.query;
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(200, Math.max(1, Number(limit) || 30));
  const skip = (pageNum - 1) * limitNum;

  const filter = { employee: req.user._id };
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = String(from);
    if (to) filter.date.$lte = String(to);
  }

  const [records, total] = await Promise.all([
    AttendanceRecord.find(filter).sort({ date: -1, time: -1 }).skip(skip).limit(limitNum).lean(),
    AttendanceRecord.countDocuments(filter),
  ]);

  return res.status(200).json(
    generateResponse("Success", "Attendance history fetched successfully", { records, total }, undefined)
  );
});
