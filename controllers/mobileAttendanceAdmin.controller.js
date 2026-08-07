import User from "../models/user.model.js";
import EmployeeFaceProfile from "../models/employeeFaceProfile.model.js";
import FaceEmbedding from "../models/faceEmbedding.model.js";
import AttendanceDaily from "../models/attendanceDaily.model.js";
import AttendanceAttempt from "../models/attendanceAttempt.model.js";
import BranchLocation from "../models/branchLocation.model.js";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import AppError from "../utility/appError.js";
import { resetEmployeeDevice } from "../services/deviceRegistration.service.js";
import { buildTodayDashboard } from "../services/attendanceTodayDashboard.service.js";
import { Parser as CsvParser } from "json2csv";

const EMPLOYEE_LIST_FIELDS =
  "name phoneNumber employeeCode department faceRegistrationStatus jobTitle role isDisabled nurserySite faceConsentAt";

/** GET /api/v1/admin/attendance/today-dashboard */
export const getTodayDashboard = catchAsync(async (req, res) => {
  const { date, branch, department, status, search } = req.query;
  const data = await buildTodayDashboard({ date, branch, department, status, search });
  return res.status(200).json(generateResponse("Success", "Today dashboard fetched", data));
});

/** GET /api/v1/admin/attendance */
export const listDailyAttendance = catchAsync(async (req, res) => {
  const { date, from, to, branch, department, employeeId, status, shift, page = 1, limit = 50 } = req.query;
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 50));

  const filter = {};
  if (date) filter.attendance_date = String(date);
  else if (from || to) {
    filter.attendance_date = {};
    if (from) filter.attendance_date.$gte = String(from);
    if (to) filter.attendance_date.$lte = String(to);
  }
  if (employeeId) filter.employee_id = employeeId;
  if (branch) filter.branch_id = branch;
  if (status) filter.attendance_status = status;
  if (shift) filter.shift_id = shift;

  if (department) {
    const ids = await User.find({ department }).distinct("_id");
    filter.employee_id = filter.employee_id ? filter.employee_id : { $in: ids };
  }

  const [records, total] = await Promise.all([
    AttendanceDaily.find(filter)
      .sort({ attendance_date: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate("employee_id", "name employeeCode department jobTitle")
      .populate("shift_id", "name code shiftStartTime shiftEndTime")
      .populate("branch_id", "name code")
      .lean(),
    AttendanceDaily.countDocuments(filter),
  ]);

  return res.status(200).json(
    generateResponse("Success", "Daily attendance fetched", { records, total, page: pageNum, limit: limitNum })
  );
});

/** GET /api/v1/admin/attendance/:attendanceId */
export const getDailyAttendanceById = catchAsync(async (req, res, next) => {
  const record = await AttendanceDaily.findById(req.params.attendanceId)
    .populate("employee_id", "name employeeCode phoneNumber department")
    .populate("shift_id", "name code shiftStartTime shiftEndTime lateGraceMinutes")
    .populate("branch_id", "name code")
    .lean();
  if (!record) return next(new AppError("Attendance record not found", 404));
  return res.status(200).json(generateResponse("Success", "Attendance detail fetched", record));
});

/** PATCH /api/v1/admin/attendance/:attendanceId */
export const patchDailyAttendance = catchAsync(async (req, res, next) => {
  const record = await AttendanceDaily.findById(req.params.attendanceId);
  if (!record) return next(new AppError("Attendance record not found", 404));

  const { check_in, check_out, attendance_status, correction_reason } = req.body;
  if (check_in) record.check_in = { ...record.check_in?.toObject?.() || record.check_in || {}, ...check_in };
  if (check_out) record.check_out = { ...record.check_out?.toObject?.() || record.check_out || {}, ...check_out };
  if (attendance_status) record.attendance_status = attendance_status;
  if (correction_reason) record.correction_reason = correction_reason;

  record.status = "CORRECTED";
  record.corrected_by = req.user._id;

  if (record.check_in?.timestamp && record.check_out?.timestamp) {
    const diff = new Date(record.check_out.timestamp) - new Date(record.check_in.timestamp);
    record.total_working_minutes = Math.max(0, Math.round(diff / 60000));
  }

  await record.save();
  return res.status(200).json(generateResponse("Success", "Attendance corrected successfully", record));
});

/** GET /api/v1/admin/attendance/attempts */
export const listAttendanceAttempts = catchAsync(async (req, res) => {
  const { from, to, employeeId, status, page = 1, limit = 50 } = req.query;
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 50));

  const filter = {};
  if (employeeId) filter.employee_id = employeeId;
  if (status) filter.verification_status = status.toUpperCase();
  if (from || to) {
    filter.attempted_at = {};
    if (from) filter.attempted_at.$gte = new Date(from);
    if (to) filter.attempted_at.$lte = new Date(`${to}T23:59:59.999Z`);
  }

  const [records, total] = await Promise.all([
    AttendanceAttempt.find(filter)
      .sort({ attempted_at: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate("employee_id", "name employeeCode")
      .lean(),
    AttendanceAttempt.countDocuments(filter),
  ]);

  return res.status(200).json(
    generateResponse("Success", "Attendance attempts fetched", { records, total, page: pageNum, limit: limitNum })
  );
});

/** GET /api/v1/admin/attendance/export.csv */
export const exportDailyAttendanceCsv = catchAsync(async (req, res, next) => {
  const { date, from, to, branch, department, employeeId, status } = req.query;
  const filter = {};
  if (date) filter.attendance_date = String(date);
  else if (from || to) {
    filter.attendance_date = {};
    if (from) filter.attendance_date.$gte = String(from);
    if (to) filter.attendance_date.$lte = String(to);
  }
  if (employeeId) filter.employee_id = employeeId;
  if (branch) filter.branch_id = branch;
  if (status) filter.attendance_status = status;
  if (department) {
    const ids = await User.find({ department }).distinct("_id");
    filter.employee_id = filter.employee_id || { $in: ids };
  }

  const records = await AttendanceDaily.find(filter)
    .sort({ attendance_date: -1 })
    .populate("employee_id", "name employeeCode")
    .populate("shift_id", "name code")
    .populate("branch_id", "name code")
    .lean();

  const rows = records.map((r) => ({
    date: r.attendance_date,
    employeeCode: r.employee_code || r.employee_id?.employeeCode || "",
    employeeName: r.employee_id?.name || "",
    department: r.shift_id?.name || "",
    branch: r.branch_id?.name || "",
    shift: r.shift_id?.code || "",
    checkIn: r.check_in?.timestamp ? new Date(r.check_in.timestamp).toISOString() : "",
    checkOut: r.check_out?.timestamp ? new Date(r.check_out.timestamp).toISOString() : "",
    workingHours: r.total_working_minutes ?? "",
    status: r.attendance_status,
    lateBy: r.late_by_minutes ?? "",
    earlyExit: r.early_exit_minutes ?? "",
    verificationMethod: r.verification_method,
    faceMatchScore: r.check_in?.face_match_score ?? r.check_out?.face_match_score ?? "",
    locationStatus: r.check_in?.location_verified ?? "",
  }));

  try {
    const csv = new CsvParser({ fields: Object.keys(rows[0] || {}) }).parse(rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="attendance-${Date.now()}.csv"`);
    return res.status(200).end(csv);
  } catch (error) {
    return next(new AppError("Error generating CSV: " + error.message, 500));
  }
});

/** GET /api/v1/admin/attendance/summary/branch */
export const branchAttendanceSummary = catchAsync(async (req, res) => {
  const { date } = req.query;
  const attendanceDate = date || new Date().toISOString().slice(0, 10);

  const summary = await AttendanceDaily.aggregate([
    { $match: { attendance_date: attendanceDate } },
    {
      $group: {
        _id: "$branch_id",
        total: { $sum: 1 },
        present: { $sum: { $cond: [{ $in: ["$attendance_status", ["PRESENT", "LATE"]] }, 1, 0] } },
        late: { $sum: { $cond: [{ $eq: ["$attendance_status", "LATE"] }, 1, 0] } },
        absent: { $sum: { $cond: [{ $eq: ["$attendance_status", "ABSENT"] }, 1, 0] } },
      },
    },
  ]);

  return res.status(200).json(generateResponse("Success", "Branch summary fetched", { date: attendanceDate, summary }));
});

/** GET /api/v1/admin/attendance/reports/late-early */
export const lateEarlyReport = catchAsync(async (req, res) => {
  const { from, to, department } = req.query;
  const filter = { $or: [{ late_by_minutes: { $gt: 0 } }, { early_exit_minutes: { $gt: 0 } }] };
  if (from || to) {
    filter.attendance_date = {};
    if (from) filter.attendance_date.$gte = String(from);
    if (to) filter.attendance_date.$lte = String(to);
  }
  if (department) {
    const ids = await User.find({ department }).distinct("_id");
    filter.employee_id = { $in: ids };
  }

  const records = await AttendanceDaily.find(filter)
    .sort({ attendance_date: -1 })
    .populate("employee_id", "name employeeCode")
    .lean();

  return res.status(200).json(generateResponse("Success", "Late/early report fetched", records));
});

/** DELETE /api/v1/admin/employees/:employeeId/face-profile */
export const deleteEmployeeFaceProfile = catchAsync(async (req, res, next) => {
  const employeeId = req.params.employeeId;
  const user = await User.findById(employeeId);
  if (!user) return next(new AppError("Employee not found", 404));

  await EmployeeFaceProfile.updateMany({ employee_id: employeeId }, { $set: { is_active: false, face_registered: false } });
  await FaceEmbedding.deleteMany({ user: employeeId });
  user.faceRegistrationStatus = "NOT_REGISTERED";
  await user.save({ validateBeforeSave: false });

  return res.status(200).json(generateResponse("Success", "Face profile reset successfully", { employeeId }));
});

/** DELETE /api/v1/admin/employees/:employeeId/device */
export const deleteEmployeeDevice = catchAsync(async (req, res, next) => {
  const employeeId = req.params.employeeId;
  const user = await User.findById(employeeId);
  if (!user) return next(new AppError("Employee not found", 404));

  await resetEmployeeDevice(employeeId);
  return res.status(200).json(generateResponse("Success", "Registered device reset successfully", { employeeId }));
});

/** GET /api/v1/admin/attendance/face-registration-status */
export const listFaceRegistrationStatus = catchAsync(async (req, res) => {
  const filter = {};
  if (req.query.department) filter.department = req.query.department;
  if (req.query.status) filter.faceRegistrationStatus = req.query.status;

  const employees = await User.find(filter).select(EMPLOYEE_LIST_FIELDS).populate("department", "name code").lean();
  const profiles = await EmployeeFaceProfile.find({ employee_id: { $in: employees.map((e) => e._id) }, is_active: true }).lean();
  const profileByEmployee = new Map(profiles.map((p) => [String(p.employee_id), p]));

  const result = employees.map((e) => ({
    ...e,
    face_profile: profileByEmployee.get(String(e._id)) || null,
    face_registered: profileByEmployee.has(String(e._id)),
  }));

  return res.status(200).json(generateResponse("Success", "Face registration status fetched", result));
});

/** Branch location CRUD */
export const listBranchLocations = catchAsync(async (_req, res) => {
  const locations = await BranchLocation.find({}).populate("branch_id", "name code").lean();
  return res.status(200).json(generateResponse("Success", "Branch locations fetched", locations));
});

export const upsertBranchLocation = catchAsync(async (req, res, next) => {
  const { branch_id, latitude, longitude, allowed_radius_meters, max_gps_accuracy_meters, is_attendance_enabled } = req.body;
  if (!branch_id || latitude == null || longitude == null) {
    return next(new AppError("branch_id, latitude, and longitude are required", 400));
  }

  const location = await BranchLocation.findOneAndUpdate(
    { branch_id },
    {
      branch_id,
      latitude,
      longitude,
      allowed_radius_meters: allowed_radius_meters ?? 200,
      max_gps_accuracy_meters: max_gps_accuracy_meters ?? 50,
      is_attendance_enabled: is_attendance_enabled ?? true,
    },
    { upsert: true, new: true, runValidators: true }
  );

  return res.status(200).json(generateResponse("Success", "Branch location saved", location));
});

export const deleteBranchLocation = catchAsync(async (req, res, next) => {
  const deleted = await BranchLocation.findByIdAndDelete(req.params.id);
  if (!deleted) return next(new AppError("Branch location not found", 404));
  return res.status(200).json(generateResponse("Success", "Branch location deleted", null));
});
