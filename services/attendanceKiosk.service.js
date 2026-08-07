import mongoose from "mongoose";
import User from "../models/user.model.js";
import EmployeeFaceProfile from "../models/employeeFaceProfile.model.js";
import AttendanceRecord from "../models/attendanceRecord.model.js";
import AttendanceDaily from "../models/attendanceDaily.model.js";
import { getIstTodayYmd } from "../utility/istCalendar.js";
import { IST_OFFSET_MS, resolveEventTime } from "../utility/attendanceEventTime.js";
import {
  getTodayEvents,
  computeCurrentStatus,
  validateTransition,
  getNextSuggestedType,
} from "../services/attendanceSequence.service.js";
import {
  identifyFaceAmongProfiles,
  registerFaceEmbeddings,
  checkDuplicateFace,
  FaceServiceError,
} from "../services/faceServiceClient.js";
import { decryptProfileEmbedding } from "../utility/faceProfileUtils.js";
import { encryptFaceDescriptor } from "../utility/faceEncryption.js";
import { uploadImageToLocalStorage } from "../utils/localStorageUtils.js";
import {
  validateShiftTiming,
  validateMinCheckoutGap,
  computeLateByMinutes,
  resolveOfficeHours,
} from "../services/attendanceRules.service.js";
import { upsertDailyAttendance } from "../services/attendanceDaily.service.js";
import { logAttendanceAttempt } from "../services/attendanceAttempt.service.js";

async function loadActiveEmbeddings(excludeEmployeeId = null) {
  const profiles = await EmployeeFaceProfile.find({ is_active: true }).lean();
  return profiles
    .filter((p) => !excludeEmployeeId || String(p.employee_id) !== String(excludeEmployeeId))
    .map((p) => ({
      employee_id: String(p.employee_id),
      embedding: decryptProfileEmbedding(p),
    }));
}

async function uploadAuditImage(buffer, folder, mimetype = "image/jpeg") {
  if (process.env.ENABLE_RAW_FACE_STORAGE !== "true" || !buffer) return null;
  const uploadResult = await uploadImageToLocalStorage(buffer, folder, { mimetype });
  return uploadResult.success ? uploadResult.url : null;
}

/**
 * Identify employee from a single face image (office kiosk).
 */
export async function identifyEmployeeFromFace(imageBuffer) {
  const existing = await loadActiveEmbeddings();
  if (existing.length === 0) {
    return { ok: false, errorCode: "FACE_NOT_REGISTERED", message: "No employees have registered faces yet." };
  }

  let identifyResult;
  try {
    identifyResult = await identifyFaceAmongProfiles(imageBuffer, existing);
  } catch (err) {
    const errorCode = err instanceof FaceServiceError ? err.errorCode : "FACE_SERVICE_UNAVAILABLE";
    return { ok: false, errorCode, message: err.message || "Face service unavailable." };
  }

  if (!identifyResult.matched || !identifyResult.employeeId) {
    return {
      ok: false,
      errorCode: identifyResult.errorCode || "FACE_NOT_MATCHED",
      message: identifyResult.message || "Face not recognized.",
      faceMatchScore: identifyResult.similarityScore,
    };
  }

  const user = await User.findById(identifyResult.employeeId).populate("department").populate("officeGroup").lean();
  if (!user || user.isDisabled) {
    return { ok: false, errorCode: "EMPLOYEE_INACTIVE", message: "Employee account is inactive." };
  }

  const profile = await EmployeeFaceProfile.findOne({
    employee_id: user._id,
    is_active: true,
  }).lean();

  const dateYmd = getIstTodayYmd();
  const events = await getTodayEvents(user._id, dateYmd);
  const currentStatus = computeCurrentStatus(events);
  const nextType = getNextSuggestedType(currentStatus);
  const daily = await AttendanceDaily.findOne({ employee_id: user._id, attendance_date: dateYmd }).lean();

  return {
    ok: true,
    employee: {
      id: String(user._id),
      name: user.name,
      employee_code: user.employeeCode || null,
      department: user.department?.name || null,
    },
    has_beard: !!profile?.has_beard,
    face_match_score: identifyResult.similarityScore,
    face_quality_score: identifyResult.qualityScore,
    next_attendance_type: nextType,
    is_checked_in: currentStatus === "CHECKED_IN" || currentStatus === "ON_BREAK",
    check_in: daily?.check_in || null,
    check_out: daily?.check_out || null,
    requires_beard_capture: !!profile?.has_beard,
  };
}

/**
 * Mark attendance via office kiosk after face (+ optional beard) capture.
 */
export async function kioskVerifyAndMark({
  adminUserId,
  imageBuffer,
  beardImageBuffer,
  ipAddress,
  branchId,
}) {
  const identify = await identifyEmployeeFromFace(imageBuffer);
  if (!identify.ok) return identify;

  const user = await User.findById(identify.employee.id).populate("department").populate("officeGroup");
  const officeHours = resolveOfficeHours(user);
  const profile = await EmployeeFaceProfile.findOne({ employee_id: user._id, is_active: true });

  if (profile?.has_beard && !beardImageBuffer) {
    return {
      ok: false,
      errorCode: "BEARD_CAPTURE_REQUIRED",
      message: "Beard verification photo required for this employee.",
      employee: identify.employee,
      next_attendance_type: identify.next_attendance_type,
      requires_beard_capture: true,
    };
  }

  const { time: eventTime } = resolveEventTime();
  const dateYmd = getIstTodayYmd();
  const todayEvents = await getTodayEvents(user._id, dateYmd);
  const currentStatus = computeCurrentStatus(todayEvents);
  const attendanceType = getNextSuggestedType(currentStatus);

  const shiftCheck = validateShiftTiming(officeHours, eventTime, attendanceType);
  if (!shiftCheck.ok) {
    await logAttendanceAttempt({
      employeeId: user._id,
      attendanceType,
      verificationStatus: "FAILED",
      failureReason: shiftCheck.message,
      errorCode: shiftCheck.errorCode,
      faceMatchScore: identify.face_match_score,
      faceQualityScore: identify.face_quality_score,
      livenessPassed: true,
      ipAddress,
      source: "KIOSK",
      markedBy: adminUserId,
    });
    return { ok: false, errorCode: shiftCheck.errorCode, message: shiftCheck.message, employee: identify.employee };
  }

  const transition = validateTransition(currentStatus, attendanceType);
  if (!transition.ok) {
    const errorCode =
      attendanceType === "CHECK_IN" ? "CHECK_IN_ALREADY_MARKED" :
      attendanceType === "CHECK_OUT" ? "CHECK_OUT_ALREADY_MARKED" :
      "CHECK_IN_REQUIRED";
    await logAttendanceAttempt({
      employeeId: user._id,
      attendanceType,
      verificationStatus: "FAILED",
      failureReason: transition.reason,
      errorCode,
      faceMatchScore: identify.face_match_score,
      livenessPassed: true,
      ipAddress,
      source: "KIOSK",
      markedBy: adminUserId,
    });
    return { ok: false, errorCode, message: transition.reason, employee: identify.employee };
  }

  if (attendanceType === "CHECK_OUT") {
    const checkInEvent = todayEvents.find((e) => e.type === "CHECK_IN");
    const gapCheck = validateMinCheckoutGap(
      checkInEvent ? new Date(checkInEvent.time) : null,
      eventTime,
      officeHours
    );
    if (!gapCheck.ok) {
      return { ok: false, errorCode: gapCheck.errorCode, message: gapCheck.message, employee: identify.employee };
    }
  }

  const auditImageUrl = await uploadAuditImage(imageBuffer, `kiosk-attendance/${user._id}/face`);
  const beardImageUrl = await uploadAuditImage(beardImageBuffer, `kiosk-attendance/${user._id}/beard`);
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
        faceMatchScore: identify.face_match_score,
        livenessPassed: true,
        selfieUrl: auditImageUrl,
        beardSelfieUrl: beardImageUrl,
        source: "KIOSK",
        markedBy: adminUserId,
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
      branchId: branchId || user.nurserySite || user.department?.branch_id,
      punchType: attendanceType,
      punchData: {
        timestamp: eventTime,
        faceMatchScore: identify.face_match_score,
        faceQualityScore: identify.face_quality_score,
        livenessPassed: true,
        auditImageUrl,
        beardImageUrl,
        locationVerified: true,
        source: "KIOSK",
        markedBy: adminUserId,
        employeeName: user.name,
      },
    });

    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }

  await logAttendanceAttempt({
    employeeId: user._id,
    attendanceType,
    verificationStatus: "SUCCESS",
    faceMatchScore: identify.face_match_score,
    faceQualityScore: identify.face_quality_score,
    livenessPassed: true,
    ipAddress,
    auditImageUrl,
    beardImageUrl,
    source: "KIOSK",
    markedBy: adminUserId,
  });

  const istTime = new Date(eventTime.getTime() + IST_OFFSET_MS);
  const timestamp = istTime.toISOString().replace("Z", "+05:30");

  return {
    ok: true,
    data: {
      attendance_type: attendanceType,
      employee_name: user.name,
      employee_code: user.employeeCode,
      timestamp,
      face_match_score: identify.face_match_score,
      is_late: late,
      record_id: attendanceRecord._id,
      beard_captured: !!beardImageUrl,
    },
  };
}

/**
 * Admin registers / re-registers an employee face from the office kiosk.
 */
export async function kioskRegisterEmployeeFace({
  adminUserId,
  employeeId,
  imageBuffers,
  hasBeard,
  beardImageBuffer,
  consent,
}) {
  const user = await User.findById(employeeId);
  if (!user || user.isDisabled) {
    return { ok: false, errorCode: "EMPLOYEE_INACTIVE", message: "Employee not found or inactive." };
  }

  if (consent !== "true" && !user.faceConsentAt) {
    return { ok: false, errorCode: "CONSENT_REQUIRED", message: "Employee face data consent is required." };
  }

  const existing = await loadActiveEmbeddings(employeeId);
  if (existing.length > 0) {
    const dupCheck = await checkDuplicateFace(imageBuffers, existing);
    if (dupCheck.is_duplicate && String(dupCheck.matched_employee_id) !== String(employeeId)) {
      return {
        ok: false,
        errorCode: "DUPLICATE_FACE",
        message: "This face is already registered to another employee.",
      };
    }
  }

  if (hasBeard && !beardImageBuffer) {
    return { ok: false, errorCode: "BEARD_CAPTURE_REQUIRED", message: "Beard reference photo is required." };
  }

  let result;
  try {
    result = await registerFaceEmbeddings(imageBuffers, String(employeeId));
  } catch (err) {
    const errorCode = err instanceof FaceServiceError ? err.errorCode : "FACE_NOT_DETECTED";
    return { ok: false, errorCode, message: err.message || "Face registration failed." };
  }

  const embedding = new Float32Array(result.embedding);
  const { encryptedVector, iv, authTag } = encryptFaceDescriptor(embedding);
  const referenceImageUrl = await uploadAuditImage(imageBuffers[0], `face-registrations/${employeeId}`);
  const beardReferenceUrl = hasBeard
    ? await uploadAuditImage(beardImageBuffer, `face-registrations/${employeeId}/beard`)
    : null;

  if (consent === "true") user.faceConsentAt = new Date();
  user.faceRegistrationStatus = "REGISTERED";
  await user.save({ validateBeforeSave: false });

  await EmployeeFaceProfile.updateMany({ employee_id: employeeId }, { $set: { is_active: false } });
  await EmployeeFaceProfile.create({
    employee_id: employeeId,
    face_embedding_enc: encryptedVector,
    iv,
    authTag,
    model_name: result.model_name || "InsightFace",
    model_version: result.model_version || "buffalo_l",
    embedding_dim: result.embedding?.length || 512,
    quality_score: result.quality_score,
    reference_image_url: referenceImageUrl,
    has_beard: !!hasBeard,
    beard_reference_image_url: beardReferenceUrl,
    face_registered: true,
    registered_by: adminUserId,
    registered_at: new Date(),
    is_active: true,
  });

  return {
    ok: true,
    data: {
      employee_id: String(employeeId),
      employee_name: user.name,
      face_registered: true,
      has_beard: !!hasBeard,
      quality_score: result.quality_score,
    },
  };
}
