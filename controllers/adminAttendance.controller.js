import { Parser as CsvParser } from "json2csv";
import User from "../models/user.model.js";
import Department from "../models/department.model.js";
import FaceEmbedding from "../models/faceEmbedding.model.js";
import AttendanceRecord from "../models/attendanceRecord.model.js";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import AppError from "../utility/appError.js";

const EMPLOYEE_LIST_FIELDS = "name phoneNumber employeeCode department faceRegistrationStatus jobTitle role isDisabled";

/** GET /api/v1/face-attendance/admin/employees — face-registration status per employee, optionally filtered by department. */
export const listEmployeesWithFaceStatus = catchAsync(async (req, res) => {
  const filter = {};
  if (req.query.department) filter.department = req.query.department;
  if (req.query.status) filter.faceRegistrationStatus = req.query.status;

  const employees = await User.find(filter).select(EMPLOYEE_LIST_FIELDS).populate("department", "name code").lean();

  const embeddingCounts = await FaceEmbedding.aggregate([
    { $match: { user: { $in: employees.map((e) => e._id) } } },
    { $group: { _id: "$user", count: { $sum: 1 } } },
  ]);
  const countByUser = new Map(embeddingCounts.map((e) => [String(e._id), e.count]));

  const result = employees.map((e) => ({
    ...e,
    registeredPoseCount: countByUser.get(String(e._id)) || 0,
  }));

  return res.status(200).json(generateResponse("Success", "Employees fetched successfully", result, undefined));
});

/** GET /api/v1/face-attendance/admin/logs?from=&to=&employeeId=&department=&page=&limit= */
export const getAttendanceLogs = catchAsync(async (req, res) => {
  const { from, to, employeeId, department, page = 1, limit = 50 } = req.query;
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 50));

  const filter = {};
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = String(from);
    if (to) filter.date.$lte = String(to);
  }
  if (employeeId) filter.employee = employeeId;

  if (department) {
    const employeeIds = await User.find({ department }).distinct("_id");
    filter.employee = filter.employee ? filter.employee : { $in: employeeIds };
  }

  const [records, total] = await Promise.all([
    AttendanceRecord.find(filter)
      .sort({ date: -1, time: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate("employee", "name employeeCode phoneNumber department")
      .lean(),
    AttendanceRecord.countDocuments(filter),
  ]);

  return res.status(200).json(
    generateResponse("Success", "Attendance logs fetched successfully", { records, total, page: pageNum, limit: limitNum }, undefined)
  );
});

/** GET /api/v1/face-attendance/admin/logs/export.csv — same filters as getAttendanceLogs, streamed as a CSV download. */
export const exportAttendanceLogsCsv = catchAsync(async (req, res, next) => {
  const { from, to, employeeId, department } = req.query;
  const filter = {};
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = String(from);
    if (to) filter.date.$lte = String(to);
  }
  if (employeeId) filter.employee = employeeId;
  if (department) {
    const employeeIds = await User.find({ department }).distinct("_id");
    filter.employee = filter.employee ? filter.employee : { $in: employeeIds };
  }

  const records = await AttendanceRecord.find(filter)
    .sort({ date: -1, time: -1 })
    .populate("employee", "name employeeCode phoneNumber")
    .lean();

  const rows = records.map((r) => ({
    date: r.date,
    time: new Date(r.time).toISOString(),
    employeeName: r.employee?.name || "",
    employeeCode: r.employee?.employeeCode || "",
    phoneNumber: r.employee?.phoneNumber || "",
    type: r.type,
    faceMatchScore: r.faceMatchScore ?? "",
    livenessPassed: r.livenessPassed,
    isLate: r.isLate,
    source: r.source,
    lat: r.location?.lat ?? "",
    lng: r.location?.lng ?? "",
    deviceName: r.device?.name || "",
    deviceCompromised: !!r.device?.isCompromised,
  }));

  try {
    const fields = [
      "date", "time", "employeeName", "employeeCode", "phoneNumber", "type",
      "faceMatchScore", "livenessPassed", "isLate", "source", "lat", "lng", "deviceName", "deviceCompromised",
    ];
    const csv = new CsvParser({ fields }).parse(rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="attendance-logs-${Date.now()}.csv"`);
    return res.status(200).end(csv);
  } catch (error) {
    return next(new AppError("Error generating CSV: " + error.message, 500));
  }
});

/** GET /api/v1/face-attendance/admin/departments */
export const listDepartments = catchAsync(async (req, res) => {
  const departments = await Department.find({}).sort({ name: 1 }).lean();
  return res.status(200).json(generateResponse("Success", "Departments fetched successfully", departments, undefined));
});

/** POST /api/v1/face-attendance/admin/departments */
export const createDepartment = catchAsync(async (req, res, next) => {
  const { name, code, shiftStartTime, lateGraceMinutes, isActive } = req.body;
  if (!name || !code) return next(new AppError("name and code are required", 400));

  const department = await Department.create({
    name,
    code: String(code).toUpperCase(),
    shiftStartTime: shiftStartTime || "09:00",
    lateGraceMinutes: lateGraceMinutes ?? 10,
    isActive: isActive ?? true,
  });

  return res.status(201).json(generateResponse("Success", "Department created successfully", department, undefined));
});

/** PATCH /api/v1/face-attendance/admin/departments/:id */
export const updateDepartment = catchAsync(async (req, res, next) => {
  const { name, code, shiftStartTime, lateGraceMinutes, isActive } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (code !== undefined) update.code = String(code).toUpperCase();
  if (shiftStartTime !== undefined) update.shiftStartTime = shiftStartTime;
  if (lateGraceMinutes !== undefined) update.lateGraceMinutes = lateGraceMinutes;
  if (isActive !== undefined) update.isActive = isActive;

  const department = await Department.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  if (!department) return next(new AppError("Department not found", 404));

  return res.status(200).json(generateResponse("Success", "Department updated successfully", department, undefined));
});

/** DELETE /api/v1/face-attendance/admin/departments/:id */
export const deleteDepartment = catchAsync(async (req, res, next) => {
  const inUse = await User.countDocuments({ department: req.params.id });
  if (inUse > 0) return next(new AppError(`Cannot delete: ${inUse} employee(s) still assigned to this department`, 409));

  const department = await Department.findByIdAndDelete(req.params.id);
  if (!department) return next(new AppError("Department not found", 404));

  return res.status(200).json(generateResponse("Success", "Department deleted successfully", null, undefined));
});
