import multer from "multer";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import {
  identifyEmployeeFromFace,
  kioskVerifyAndMark,
  kioskRegisterEmployeeFace,
} from "../services/attendanceKiosk.service.js";

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

export const kioskMarkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    cb(ALLOWED_MIME_TYPES.includes(file.mimetype) ? null : new Error("Only JPG/PNG/WEBP images are allowed"), true);
  },
}).fields([
  { name: "image", maxCount: 1 },
  { name: "beard_image", maxCount: 1 },
]);

export const kioskRegisterUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, cb) => {
    cb(ALLOWED_MIME_TYPES.includes(file.mimetype) ? null : new Error("Only JPG/PNG/WEBP images are allowed"), true);
  },
}).fields([
  { name: "image", maxCount: 5 },
  { name: "beard_image", maxCount: 1 },
]);

function getSingleFile(files, field) {
  const list = files?.[field];
  return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

/** POST /api/v1/admin/attendance/kiosk/identify */
export const kioskIdentify = catchAsync(async (req, res) => {
  const faceFile = getSingleFile(req.files, "image") || req.file;
  if (!faceFile) {
    return res.status(400).json({ status: false, message: "Face image is required.", error_code: "FACE_NOT_DETECTED" });
  }

  const result = await identifyEmployeeFromFace(faceFile.buffer);
  if (!result.ok) {
    return res.status(200).json({
      status: false,
      message: result.message,
      error_code: result.errorCode,
      data: { face_match_score: result.faceMatchScore ?? null },
    });
  }

  return res.status(200).json(
    generateResponse("Success", "Employee identified", {
      employee: result.employee,
      has_beard: result.has_beard,
      requires_beard_capture: result.requires_beard_capture,
      face_match_score: result.face_match_score,
      next_attendance_type: result.next_attendance_type,
      is_checked_in: result.is_checked_in,
      check_in: result.check_in,
      check_out: result.check_out,
    })
  );
});

/** POST /api/v1/admin/attendance/kiosk/verify-and-mark */
export const kioskVerifyAndMarkHandler = catchAsync(async (req, res) => {
  const faceFile = getSingleFile(req.files, "image");
  const beardFile = getSingleFile(req.files, "beard_image");

  if (!faceFile) {
    return res.status(400).json({ status: false, message: "Face image is required.", error_code: "FACE_NOT_DETECTED" });
  }

  const result = await kioskVerifyAndMark({
    adminUserId: req.user._id,
    imageBuffer: faceFile.buffer,
    beardImageBuffer: beardFile?.buffer || null,
    ipAddress: req.ip,
    branchId: req.body.branch_id || null,
  });

  if (!result.ok) {
    return res.status(200).json({
      status: false,
      message: result.message,
      error_code: result.errorCode,
      data: {
        employee: result.employee || null,
        next_attendance_type: result.next_attendance_type || null,
        requires_beard_capture: result.requires_beard_capture || false,
      },
    });
  }

  return res.status(200).json(generateResponse("Success", "Attendance marked successfully", result.data));
});

/** POST /api/v1/admin/attendance/kiosk/register-face */
export const kioskRegisterFace = catchAsync(async (req, res) => {
  const employeeId = req.body.employee_id;
  if (!employeeId) {
    return res.status(400).json({ status: false, message: "employee_id is required." });
  }

  const faceFiles = req.files?.image || [];
  if (faceFiles.length < 1) {
    return res.status(400).json({ status: false, message: "At least one face image is required." });
  }

  const hasBeard = String(req.body.has_beard).toLowerCase() === "true";
  const beardFile = getSingleFile(req.files, "beard_image");

  const result = await kioskRegisterEmployeeFace({
    adminUserId: req.user._id,
    employeeId,
    imageBuffers: faceFiles.map((f) => f.buffer),
    hasBeard,
    beardImageBuffer: beardFile?.buffer || null,
    consent: req.body.consent,
  });

  if (!result.ok) {
    return res.status(200).json({
      status: false,
      message: result.message,
      error_code: result.errorCode,
    });
  }

  return res.status(200).json(generateResponse("Success", "Face registered successfully", result.data));
});
