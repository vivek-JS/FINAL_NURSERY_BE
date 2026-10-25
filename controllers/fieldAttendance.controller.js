import FieldAttendance from "../models/fieldAttendance.model.js";
import User from "../models/user.model.js";
import { istDay } from "../services/fieldLead.service.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";

function pointOf(body) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const accuracy = Number(body.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new AppError("Location is required", 400);
  }
  const area = String(body.area || "").trim().slice(0, 180);
  return { lat, lng, accuracy: Number.isFinite(accuracy) ? accuracy : undefined, area };
}

function rejectSpoof(body) {
  if (body.mocked === true || body.mocked === "true") {
    throw new AppError("Fake location is not allowed. Turn off mock location and try again.", 400);
  }
  if (body.developerMode === true || body.developerMode === "true") {
    throw new AppError("Turn off developer options, then clock in again.", 400);
  }
}

export const clockIn = catchAsync(async (req, res, next) => {
  try {
    rejectSpoof(req.body);
    const point = pointOf(req.body);
    const { ymd } = istDay();
    const open = await FieldAttendance.findOne({ userId: req.user._id, date: ymd, clockOutAt: null });
    if (open) {
      return res.status(200).json(generateResponse("success", "Already clocked in", { session: open }));
    }
    const session = await FieldAttendance.create({
      userId: req.user._id,
      date: ymd,
      clockInAt: new Date(),
      clockIn: point,
      punches: [{ at: new Date(), ...point }],
    });
    return res.status(201).json(generateResponse("success", "Clocked in", { session }));
  } catch (err) {
    return next(err instanceof AppError ? err : err);
  }
});

export const clockOut = catchAsync(async (req, res, next) => {
  try {
    rejectSpoof(req.body);
    const point = pointOf(req.body);
    const { ymd } = istDay();
    const session = await FieldAttendance.findOne({ userId: req.user._id, date: ymd, clockOutAt: null });
    if (!session) return next(new AppError("You are not clocked in", 400));
    session.clockOutAt = new Date();
    session.clockOut = point;
    session.autoClockOut = false;
    session.punches.push({ at: session.clockOutAt, ...point });
    await session.save();
    return res.status(200).json(generateResponse("success", "Clocked out", { session }));
  } catch (err) {
    return next(err instanceof AppError ? err : err);
  }
});

export const punchLocation = catchAsync(async (req, res, next) => {
  try {
    rejectSpoof(req.body);
    const point = pointOf(req.body);
    const { ymd } = istDay();
    const session = await FieldAttendance.findOne({ userId: req.user._id, date: ymd, clockOutAt: null });
    if (!session) return next(new AppError("You are not clocked in", 400));
    const last = session.punches[session.punches.length - 1];
    const elapsed = last ? Date.now() - new Date(last.at).getTime() : Infinity;
    if (elapsed < 25 * 60 * 1000) {
      return res.status(200).json(generateResponse("success", "Punch already recorded", { session }));
    }
    session.punches.push({ at: new Date(), ...point });
    await session.save();
    return res.status(201).json(generateResponse("success", "Location punched", { session }));
  } catch (err) {
    return next(err instanceof AppError ? err : err);
  }
});

export const attendanceBoard = catchAsync(async (req, res) => {
  const day = req.query.date ? istDay(new Date(`${req.query.date}T12:00:00+05:30`)) : istDay();
  const sessions = await FieldAttendance.find({ date: day.ymd }).sort({ clockInAt: -1 }).lean();
  const users = await User.find({ _id: { $in: sessions.map((row) => row.userId) } })
    .select("name phoneNumber")
    .lean();
  const userById = new Map(users.map((user) => [String(user._id), user]));
  return res.status(200).json(
    generateResponse("success", "Field attendance", {
      date: day.ymd,
      sessions: sessions.map((session) => ({
        ...session,
        user: userById.get(String(session.userId)) || null,
      })),
    })
  );
});

export const todayAttendance = catchAsync(async (req, res) => {
  const { ymd } = istDay();
  const session = await FieldAttendance.findOne({ userId: req.user._id, date: ymd }).lean();
  return res.status(200).json(generateResponse("success", "Today's attendance", { session }));
});

export async function autoClockOutOpenSessions(now = new Date()) {
  const { ymd } = istDay(now);
  const result = await FieldAttendance.updateMany(
    { date: ymd, clockOutAt: null },
    { $set: { clockOutAt: now, autoClockOut: true } }
  );
  return result.modifiedCount || 0;
}
