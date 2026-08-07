import AttendanceDaily from "../models/attendanceDaily.model.js";
import {
  computeEarlyExitMinutes,
  computeLateByMinutes,
  deriveAttendanceStatus,
} from "./attendanceRules.service.js";

function buildPunchPayload({
  timestamp,
  latitude,
  longitude,
  gpsAccuracy,
  deviceId,
  faceMatchScore,
  faceQualityScore,
  livenessPassed,
  auditImageUrl,
  beardImageUrl,
  locationVerified,
  source,
  markedBy,
  employeeName,
}) {
  return {
    timestamp,
    latitude: latitude ?? null,
    longitude: longitude ?? null,
    gps_accuracy: gpsAccuracy ?? null,
    device_id: deviceId ?? null,
    face_match_score: faceMatchScore ?? null,
    face_quality_score: faceQualityScore ?? null,
    liveness_passed: livenessPassed ?? false,
    audit_image_url: auditImageUrl ?? null,
    beard_image_url: beardImageUrl ?? null,
    location_verified: locationVerified ?? null,
    source: source || "MOBILE",
    marked_by: markedBy ?? null,
    employee_name: employeeName ?? null,
  };
}

/**
 * Upserts the daily attendance rollup after a successful punch.
 */
export async function upsertDailyAttendance({
  employeeId,
  employeeCode,
  attendanceDate,
  department,
  officeHours,
  branchId,
  punchType,
  punchData,
}) {
  const hours = officeHours || department || {};
  const filter = { employee_id: employeeId, attendance_date: attendanceDate };
  let doc = await AttendanceDaily.findOne(filter);

  if (!doc) {
    doc = new AttendanceDaily({
      employee_id: employeeId,
      employee_code: employeeCode || null,
      attendance_date: attendanceDate,
      shift_id: department?._id || department || null,
      branch_id: branchId || department?.branch_id || null,
      office_group_id: hours.office_group_id || null,
      office_start_time: hours.officeStartTime || null,
      office_end_time: hours.officeEndTime || null,
      attendance_status: "ABSENT",
    });
  }

  if (punchType === "CHECK_IN" && hours.officeStartTime) {
    doc.office_group_id = hours.office_group_id || doc.office_group_id;
    doc.office_start_time = hours.officeStartTime;
    doc.office_end_time = hours.officeEndTime || doc.office_end_time;
  }

  const punch = buildPunchPayload(punchData);

  if (punchType === "CHECK_IN") {
    doc.check_in = punch;
  } else if (punchType === "CHECK_OUT") {
    doc.check_out = punch;
  }

  const checkInTime = doc.check_in?.timestamp ? new Date(doc.check_in.timestamp) : null;
  const checkOutTime = doc.check_out?.timestamp ? new Date(doc.check_out.timestamp) : null;

  if (checkInTime && checkOutTime) {
    doc.total_working_minutes = Math.max(0, Math.round((checkOutTime - checkInTime) / 60000));
  }

  doc.late_by_minutes = checkInTime ? computeLateByMinutes(checkInTime, hours) : doc.late_by_minutes || 0;
  doc.early_exit_minutes = checkOutTime ? computeEarlyExitMinutes(checkOutTime, hours) : doc.early_exit_minutes || 0;
  doc.attendance_status = deriveAttendanceStatus({
    checkInTime,
    checkOutTime,
    department: hours,
    lateByMinutes: doc.late_by_minutes,
    earlyExitMinutes: doc.early_exit_minutes,
  });
  doc.verification_method = "FACE";

  await doc.save();
  return doc;
}

export async function getDailyAttendance(employeeId, attendanceDate) {
  return AttendanceDaily.findOne({ employee_id: employeeId, attendance_date: attendanceDate }).lean();
}

export async function getAttendanceHistory(employeeId, { from, to, page = 1, limit = 30 }) {
  const filter = { employee_id: employeeId };
  if (from || to) {
    filter.attendance_date = {};
    if (from) filter.attendance_date.$gte = String(from);
    if (to) filter.attendance_date.$lte = String(to);
  }

  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 30));

  const [records, total] = await Promise.all([
    AttendanceDaily.find(filter)
      .sort({ attendance_date: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
    AttendanceDaily.countDocuments(filter),
  ]);

  return { records, total, page: pageNum, limit: limitNum };
}
