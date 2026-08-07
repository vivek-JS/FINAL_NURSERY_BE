import multer from "multer";
import mongoose from "mongoose";
import User from "../models/user.model.js";
import EmployeeFaceProfile from "../models/employeeFaceProfile.model.js";
import AttendanceRecord from "../models/attendanceRecord.model.js";
import BranchLocation from "../models/branchLocation.model.js";
import AttendanceDaily from "../models/attendanceDaily.model.js";
import "../models/department.model.js";
import catchAsync from "../utility/catchAsync.js";
import { uploadImageToLocalStorage } from "../utils/localStorageUtils.js";
import { getIstTodayYmd } from "../utility/istCalendar.js";
import { IST_OFFSET_MS, resolveEventTime, toIstYmd } from "../utility/attendanceEventTime.js";
import {
  getTodayEvents,
  computeCurrentStatus,
  validateTransition,
  buildTodaySummary,
  getNextSuggestedType,
} from "../services/attendanceSequence.service.js";
import { verifyFaceEmbedding, getMatchThreshold, FaceServiceError } from "../services/faceServiceClient.js";
import { decryptProfileEmbedding } from "../utility/faceProfileUtils.js";
import { validateGeofence } from "../services/geofence.service.js";
import { validateAndRegisterDevice } from "../services/deviceRegistration.service.js";
import {
  validateShiftTiming,
  validateMinCheckoutGap,
  computeLateByMinutes,
  resolveOfficeHours,
} from "../services/attendanceRules.service.js";
import { upsertDailyAttendance, getAttendanceHistory } from "../services/attendanceDaily.service.js";
import { logAttendanceAttempt } from "../services/attendanceAttempt.service.js";
import {
  sendAttendanceSuccessNotification,
  sendAttendanceFailedNotification,
  sendAlreadyCheckedInNotification,
} from "../utility/attendanceNotification.js";

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

export const verifyAndMarkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(ALLOWED_MIME_TYPES.includes(file.mimetype) ? null : new Error("Only JPG/PNG/WEBP images are allowed"), true);
  },
}).single("image");

function notifyAsync(sendFn, ...args) {
  Promise.resolve(sendFn(...args)).catch((err) => {
    console.error("[Attendance] Push notification failed:", err?.message || err);
  });
}

function fail(res, { message, errorCode, data = {}, httpStatus = 200 }) {
  return res.status(httpStatus).json({
    status: false,
    message,
    error_code: errorCode,
    data,
  });
}

function success(res, { message, data }) {
  return res.status(200).json({
    status: true,
    message,
    data,
  });
}

async function resolveBranchLocation(user) {
  const branchId = user.nurserySite || user.department?.branch_id;
  if (!branchId) return null;
  return BranchLocation.findOne({ branch_id: branchId, is_attendance_enabled: true }).lean();
}

async function logAttempt(req, payload) {
  return logAttendanceAttempt({
    employeeId: req.user._id,
    ipAddress: req.ip,
    ...payload,
  });
}

/**
 * GET /api/v1/mobile/attendance/today
 */
export const getToday = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).populate("department").populate("officeGroup").lean();
  const dateYmd = getIstTodayYmd();
  const events = await getTodayEvents(req.user._id, dateYmd);
  const summary = buildTodaySummary(events, dateYmd);
  const daily = await AttendanceDaily.findOne({ employee_id: req.user._id, attendance_date: dateYmd }).lean();
  const currentStatus = computeCurrentStatus(events);

  return success(res, {
    message: "Today's attendance fetched",
    data: {
      date: dateYmd,
      employee_name: user?.name,
      employee_code: user?.employeeCode,
      shift: (() => {
        const h = resolveOfficeHours(user);
        return h.officeStartTime ? `${h.officeStartTime} - ${h.officeEndTime || ""}` : null;
      })(),
      events: summary.events,
      nextSuggestedType: summary.nextSuggestedType,
      isCheckedIn: summary.isCheckedIn,
      onBreak: summary.onBreak,
      workingMinutesSoFar: summary.workingMinutesSoFar,
      check_in: daily?.check_in || null,
      check_out: daily?.check_out || null,
      attendance_status: daily?.attendance_status || (summary.isCheckedIn ? "PRESENT" : "ABSENT"),
      next_attendance_type: getNextSuggestedType(currentStatus),
    },
  });
});

/**
 * GET /api/v1/mobile/attendance/history
 */
export const getHistory = catchAsync(async (req, res) => {
  const { from, to, page, limit } = req.query;
  const result = await getAttendanceHistory(req.user._id, { from, to, page, limit });
  return success(res, { message: "Attendance history fetched", data: result });
});

/**
 * POST /api/v1/mobile/attendance/verify-and-mark
 */
export const verifyAndMark = catchAsync(async (req, res) => {
  const livenessPassed = String(req.body.livenessPassed ?? req.body.liveness_passed).toLowerCase() === "true";
  const latitude = req.body.latitude != null ? Number(req.body.latitude) : null;
  const longitude = req.body.longitude != null ? Number(req.body.longitude) : null;
  const gpsAccuracy = req.body.gps_accuracy != null ? Number(req.body.gps_accuracy) : null;
  const deviceId = req.body.device_id || null;
  const appVersion = req.body.app_version || null;
  const livenessChallenge = req.body.liveness_challenge || req.body.livenessChallenge || null;

  const user = await User.findById(req.user._id).populate("department").populate("officeGroup");
  if (!user) {
    return fail(res, { message: "User not found.", errorCode: "EMPLOYEE_INACTIVE" });
  }

  if (user.isDisabled) {
    await logAttempt(req, {
      verificationStatus: "FAILED",
      failureReason: "Employee inactive",
      errorCode: "EMPLOYEE_INACTIVE",
      livenessPassed,
      latitude,
      longitude,
      gpsAccuracy,
      deviceId,
    });
    return fail(res, { message: "Your account is inactive.", errorCode: "EMPLOYEE_INACTIVE" });
  }

  if (!req.file) {
    return fail(res, { message: "No image received.", errorCode: "FACE_NOT_DETECTED" });
  }

  const profile = await EmployeeFaceProfile.findOne({ employee_id: user._id, is_active: true });
  if (!profile || user.faceRegistrationStatus !== "REGISTERED") {
    await logAttempt(req, {
      verificationStatus: "FAILED",
      failureReason: "Face not registered",
      errorCode: "FACE_NOT_REGISTERED",
      livenessPassed,
      latitude,
      longitude,
      gpsAccuracy,
      deviceId,
    });
    return fail(res, { message: "Face is not registered. Complete face registration first.", errorCode: "FACE_NOT_REGISTERED" });
  }

  if (!livenessPassed) {
    await logAttempt(req, {
      verificationStatus: "FAILED",
      failureReason: "Liveness failed",
      errorCode: "LIVENESS_FAILED",
      livenessPassed: false,
      latitude,
      longitude,
      gpsAccuracy,
      deviceId,
    });
    notifyAsync(sendAttendanceFailedNotification, user.expoPushToken, "Liveness check failed.");
    return fail(res, { message: "Liveness validation failed.", errorCode: "LIVENESS_FAILED" });
  }

  const deviceCheck = await validateAndRegisterDevice(user._id, {
    deviceId,
    deviceName: req.body.device_name,
    platform: req.body.platform,
    appVersion,
  });
  if (!deviceCheck.ok) {
    await logAttempt(req, {
      verificationStatus: "FAILED",
      failureReason: deviceCheck.message,
      errorCode: deviceCheck.errorCode,
      livenessPassed,
      latitude,
      longitude,
      gpsAccuracy,
      deviceId,
    });
    return fail(res, { message: deviceCheck.message, errorCode: deviceCheck.errorCode });
  }

  const branchLocation = await resolveBranchLocation(user);
  const geofence = validateGeofence({ latitude, longitude, gpsAccuracy }, branchLocation);
  if (!geofence.ok) {
    await logAttempt(req, {
      verificationStatus: "FAILED",
      failureReason: geofence.message,
      errorCode: geofence.errorCode,
      livenessPassed,
      latitude,
      longitude,
      gpsAccuracy,
      deviceId,
    });
    return fail(res, { message: geofence.message, errorCode: geofence.errorCode });
  }

  const { time: eventTime } = resolveEventTime(req.body.capturedAt);
  const isOfflineSync = String(req.body.source).toUpperCase() === "OFFLINE_SYNCED";
  const dateYmd = isOfflineSync ? toIstYmd(eventTime) : getIstTodayYmd();

  if (isOfflineSync) {
    const maxDelay = Number(process.env.MAX_OFFLINE_SUBMISSION_DELAY_MINUTES) || 15;
    const delayMin = (Date.now() - eventTime.getTime()) / 60000;
    if (delayMin > maxDelay) {
      return fail(res, {
        message: "Offline submission expired. Please mark attendance while online.",
        errorCode: "NETWORK_ERROR",
      });
    }
  }

  const todayEvents = await getTodayEvents(user._id, dateYmd);
  const currentStatus = computeCurrentStatus(todayEvents);
  const attendanceType = getNextSuggestedType(currentStatus);

  const officeHours = resolveOfficeHours(user);

  const shiftCheck = validateShiftTiming(officeHours, eventTime, attendanceType);
  if (!shiftCheck.ok) {
    await logAttempt(req, {
      attendanceType,
      verificationStatus: "FAILED",
      failureReason: shiftCheck.message,
      errorCode: shiftCheck.errorCode,
      livenessPassed,
      latitude,
      longitude,
      gpsAccuracy,
      deviceId,
    });
    return fail(res, { message: shiftCheck.message, errorCode: shiftCheck.errorCode });
  }

  const transition = validateTransition(currentStatus, attendanceType);
  if (!transition.ok) {
    const errorCode =
      attendanceType === "CHECK_IN" ? "CHECK_IN_ALREADY_MARKED" :
      attendanceType === "CHECK_OUT" ? "CHECK_OUT_ALREADY_MARKED" :
      "CHECK_IN_REQUIRED";
    await logAttempt(req, {
      attendanceType,
      verificationStatus: "FAILED",
      failureReason: transition.reason,
      errorCode,
      livenessPassed,
      latitude,
      longitude,
      gpsAccuracy,
      deviceId,
    });
    notifyAsync(sendAlreadyCheckedInNotification, user.expoPushToken, transition.reason);
    return fail(res, { message: transition.reason, errorCode });
  }

  if (attendanceType === "CHECK_OUT") {
    const checkInEvent = todayEvents.find((e) => e.type === "CHECK_IN");
    const gapCheck = validateMinCheckoutGap(
      checkInEvent ? new Date(checkInEvent.time) : null,
      eventTime,
      officeHours
    );
    if (!gapCheck.ok) {
      return fail(res, { message: gapCheck.message, errorCode: gapCheck.errorCode });
    }
  }

  let verifyResult;
  try {
    const embedding = decryptProfileEmbedding(profile);
    verifyResult = await verifyFaceEmbedding(req.file.buffer, embedding);
  } catch (err) {
    const errorCode = err instanceof FaceServiceError ? err.errorCode : "FACE_SERVICE_UNAVAILABLE";
    await logAttempt(req, {
      attendanceType,
      verificationStatus: "FAILED",
      failureReason: err.message,
      errorCode,
      livenessPassed,
      latitude,
      longitude,
      gpsAccuracy,
      deviceId,
    });
    return fail(res, {
      message: err.message || "Face verification service unavailable.",
      errorCode,
    });
  }

  if (!verifyResult.matched) {
    await logAttempt(req, {
      attendanceType,
      verificationStatus: "FAILED",
      failureReason: verifyResult.message || "Face mismatch",
      errorCode: verifyResult.errorCode || "FACE_NOT_MATCHED",
      faceMatchScore: verifyResult.similarityScore,
      faceQualityScore: verifyResult.qualityScore,
      livenessPassed,
      latitude,
      longitude,
      gpsAccuracy,
      deviceId,
    });
    notifyAsync(sendAttendanceFailedNotification, user.expoPushToken, "Face verification failed.");
    return fail(res, {
      message: "Face verification failed",
      errorCode: verifyResult.errorCode || "FACE_NOT_MATCHED",
      data: { face_match_score: verifyResult.similarityScore },
    });
  }

  let auditImageUrl = null;
  if (process.env.ENABLE_RAW_FACE_STORAGE === "true") {
    const uploadResult = await uploadImageToLocalStorage(req.file.buffer, `attendance-selfies/${user._id}`, {
      mimetype: req.file.mimetype,
    });
    if (uploadResult.success) auditImageUrl = uploadResult.url;
  }

  const late = attendanceType === "CHECK_IN" ? computeLateByMinutes(eventTime, officeHours) > 0 : false;

  const session = await mongoose.startSession();
  let attendanceRecord;
  try {
    session.startTransaction();

    attendanceRecord = await AttendanceRecord.create(
      [{
        employee: user._id,
        type: attendanceType,
        date: dateYmd,
        time: eventTime,
        location: { lat: latitude, lng: longitude },
        device: {
          name: req.body.device_name || null,
          id: deviceId,
          os: req.body.platform || null,
          isCompromised: false,
        },
        faceMatchScore: verifyResult.similarityScore,
        livenessPassed: true,
        livenessChallenge,
        selfieUrl: auditImageUrl,
        source: isOfflineSync ? "OFFLINE_SYNCED" : "ONLINE",
        isLate: late,
      }],
      { session }
    ).then((docs) => docs[0]);

    await upsertDailyAttendance({
      employeeId: user._id,
      employeeCode: user.employeeCode,
      attendanceDate: dateYmd,
      department: user.department,
      officeHours,
      branchId: user.nurserySite || user.department?.branch_id,
      punchType: attendanceType,
      punchData: {
        timestamp: eventTime,
        latitude,
        longitude,
        gpsAccuracy,
        deviceId,
        faceMatchScore: verifyResult.similarityScore,
        faceQualityScore: verifyResult.qualityScore,
        livenessPassed: true,
        auditImageUrl,
        locationVerified: geofence.locationVerified,
      },
    });

    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }

  await logAttempt(req, {
    attendanceType,
    verificationStatus: "SUCCESS",
    faceMatchScore: verifyResult.similarityScore,
    faceQualityScore: verifyResult.qualityScore,
    livenessPassed: true,
    latitude,
    longitude,
    gpsAccuracy,
    deviceId,
    auditImageUrl,
  });

  notifyAsync(sendAttendanceSuccessNotification, user.expoPushToken, attendanceType, { isLate: late });

  const istOffset = IST_OFFSET_MS;
  const istTime = new Date(eventTime.getTime() + istOffset);
  const timestamp = istTime.toISOString().replace("Z", "+05:30");

  return success(res, {
    message: "Attendance marked successfully",
    data: {
      attendance_type: attendanceType,
      employee_name: user.name,
      timestamp,
      face_match_score: verifyResult.similarityScore,
      liveness_passed: true,
      location_verified: geofence.locationVerified ?? true,
      is_late: late,
      record_id: attendanceRecord._id,
    },
  });
});
