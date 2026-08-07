import multer from "multer";
import User from "../models/user.model.js";
import FaceEmbedding from "../models/faceEmbedding.model.js";
import AttendanceRecord from "../models/attendanceRecord.model.js";
import "../models/department.model.js"; // registers "Department" for the .populate() below
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import { detectSingleFaceOrThrow, findBestMatch, getMatchThreshold } from "../services/faceRecognition.service.js";
import { assessImageQuality } from "../utility/imageQuality.js";
import { decryptFaceDescriptor } from "../utility/faceEncryption.js";
import { uploadImageToLocalStorage } from "../utils/localStorageUtils.js";
import { getIstTodayYmd } from "../utility/istCalendar.js";
import { IST_OFFSET_MS, resolveEventTime, toIstYmd } from "../utility/attendanceEventTime.js";
import { getTodayEvents, computeCurrentStatus, validateTransition, VALID_TYPES } from "../services/attendanceSequence.service.js";
import {
  sendAttendanceSuccessNotification,
  sendAttendanceFailedNotification,
  sendAlreadyCheckedInNotification,
} from "../utility/attendanceNotification.js";

/** Fire-and-forget push notification — never lets a delivery failure affect the API response. */
function notifyAsync(sendFn, ...args) {
  Promise.resolve(sendFn(...args)).catch((err) => {
    console.error("[Attendance] Push notification failed:", err?.message || err);
  });
}

const ATTENDANCE_TYPE_LABEL = {
  CHECK_IN: "Checked in",
  CHECK_OUT: "Checked out",
  BREAK_START: "Break started",
  BREAK_END: "Break ended",
};

export const verifyFaceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Only JPG/PNG/WEBP images are allowed"), ok);
  },
}).single("selfie");

function parseJsonField(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Compares "HH:mm" shift start (+ grace minutes) against an actual check-in Date, IST-aware. */
function isLateCheckIn(checkInTime, department) {
  if (!department?.shiftStartTime) return false;
  const [hh, mm] = department.shiftStartTime.split(":").map(Number);
  const grace = Number.isFinite(department.lateGraceMinutes) ? department.lateGraceMinutes : 10;

  // Build the shift-start instant on the same IST calendar day as checkInTime.
  const istMs = checkInTime.getTime() + IST_OFFSET_MS;
  const istDate = new Date(istMs);
  const shiftStartIstMinutes = hh * 60 + mm + grace;
  const checkInIstMinutes = istDate.getUTCHours() * 60 + istDate.getUTCMinutes();

  return checkInIstMinutes > shiftStartIstMinutes;
}

/**
 * POST /api/v1/face-attendance/verify-face
 * Single combined endpoint the mobile app calls for every attendance action:
 * verifies the live selfie against the employee's stored face embeddings and,
 * on a match, records the attendance event for `type`. Returns HTTP 200 with
 * `matched: false` for business-logic failures (no match, bad framing, invalid
 * sequence) — only real infra/auth errors use non-2xx statuses — because the
 * mobile client treats any thrown request error as "queue for offline sync".
 *
 * When draining that queue the client resends the same payload plus
 * `source=OFFLINE_SYNCED` and `capturedAt` (ISO), which backdates the record to
 * when it was actually taken instead of when it reached the server.
 */
export const verifyFace = catchAsync(async (req, res) => {
  const respond = (payload) =>
    res.status(200).json(generateResponse("Success", payload.message, payload, undefined));

  if (!req.file) {
    return respond({ matched: false, matchScore: 0, threshold: getMatchThreshold(), livenessPassed: false, message: "No selfie image was received. Please try again." });
  }

  const { type, livenessChallenge } = req.body;
  const livenessPassed = String(req.body.livenessPassed).toLowerCase() === "true";
  const device = parseJsonField(req.body.device) || {};
  const location = parseJsonField(req.body.location);

  if (!VALID_TYPES.includes(type)) {
    return respond({
      matched: false,
      matchScore: 0,
      threshold: getMatchThreshold(),
      livenessPassed,
      message: `Invalid attendance type "${type}".`,
    });
  }

  const user = await User.findById(req.user._id).populate("department");
  if (!user) {
    return respond({ matched: false, matchScore: 0, threshold: getMatchThreshold(), livenessPassed, message: "User not found." });
  }

  if (user.faceRegistrationStatus !== "REGISTERED") {
    return respond({
      matched: false,
      matchScore: 0,
      threshold: getMatchThreshold(),
      livenessPassed,
      message: "Face is not registered yet. Please complete face registration first.",
    });
  }

  if (!livenessPassed) {
    notifyAsync(sendAttendanceFailedNotification, user.expoPushToken, "Liveness check failed. Please use your own live face, not a photo or screen.");
    return respond({
      matched: false,
      matchScore: 0,
      threshold: getMatchThreshold(),
      livenessPassed: false,
      message: "Liveness check failed. Please use your own live face, not a photo or screen.",
    });
  }

  // Offline-synced entries are validated and stored against the day they were
  // captured on, not the day the queue happened to drain.
  const { time: eventTime } = resolveEventTime(req.body.capturedAt);
  const isOfflineSync = String(req.body.source).toUpperCase() === "OFFLINE_SYNCED";
  const dateYmd = isOfflineSync ? toIstYmd(eventTime) : getIstTodayYmd();

  const todayEvents = await getTodayEvents(user._id, dateYmd);
  const currentStatus = computeCurrentStatus(todayEvents);
  const transition = validateTransition(currentStatus, type);
  if (!transition.ok) {
    notifyAsync(sendAlreadyCheckedInNotification, user.expoPushToken, transition.reason);
    return respond({
      matched: false,
      matchScore: 0,
      threshold: getMatchThreshold(),
      livenessPassed,
      message: transition.reason,
    });
  }

  const quality = await assessImageQuality(req.file.buffer);
  if (!quality.ok) {
    const message = `Photo quality issue (${quality.reason}). Please retake in better lighting.`;
    notifyAsync(sendAttendanceFailedNotification, user.expoPushToken, message);
    return respond({
      matched: false,
      matchScore: 0,
      threshold: getMatchThreshold(),
      livenessPassed,
      message,
    });
  }

  let liveDescriptor;
  try {
    // Reuses the decode from the quality check above instead of re-decoding the upload.
    const { detection } = await detectSingleFaceOrThrow(quality.prepared);
    liveDescriptor = detection.descriptor;
  } catch (err) {
    notifyAsync(sendAttendanceFailedNotification, user.expoPushToken, err.message);
    return respond({
      matched: false,
      matchScore: 0,
      threshold: getMatchThreshold(),
      livenessPassed,
      message: err.message,
    });
  }

  const storedEmbeddings = await FaceEmbedding.find({ user: user._id });
  const storedDescriptors = storedEmbeddings.map((e) => decryptFaceDescriptor(e));
  const threshold = getMatchThreshold();
  const { isMatch, matchScore, distance } = findBestMatch(liveDescriptor, storedDescriptors, threshold);

  if (!isMatch) {
    const message = "Face didn't match your registered profile. Please try again.";
    notifyAsync(sendAttendanceFailedNotification, user.expoPushToken, message);
    return respond({
      matched: false,
      matchScore,
      threshold,
      livenessPassed,
      message,
    });
  }

  let selfieUrl = null;
  if (process.env.ENABLE_RAW_FACE_STORAGE === "true") {
    const uploadResult = await uploadImageToLocalStorage(req.file.buffer, `attendance-selfies/${user._id}`, {
      mimetype: req.file.mimetype,
    });
    if (uploadResult.success) selfieUrl = uploadResult.url;
  }

  const late = type === "CHECK_IN" ? isLateCheckIn(eventTime, user.department) : false;

  const attendance = await AttendanceRecord.create({
    employee: user._id,
    type,
    date: dateYmd,
    time: eventTime,
    location: location ? { lat: location.latitude ?? null, lng: location.longitude ?? null } : undefined,
    device: {
      name: device.deviceName || null,
      id: device.deviceId || null,
      os: device.os || null,
      isCompromised: !!device.isCompromised,
    },
    faceMatchScore: matchScore,
    livenessPassed: true,
    livenessChallenge: livenessChallenge || null,
    selfieUrl,
    source: isOfflineSync ? "OFFLINE_SYNCED" : "ONLINE",
    isLate: late,
  });

  const label = ATTENDANCE_TYPE_LABEL[type] || type;
  const message = late ? `${label} successfully (marked late).` : `${label} successfully.`;

  notifyAsync(sendAttendanceSuccessNotification, user.expoPushToken, type, { isLate: late });

  return respond({
    matched: true,
    matchScore,
    threshold,
    distance,
    livenessPassed: true,
    attendance,
    message,
  });
});
