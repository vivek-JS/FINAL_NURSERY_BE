import multer from "multer";
import User from "../models/user.model.js";
import FaceEmbedding from "../models/faceEmbedding.model.js";
import AppError from "../utility/appError.js";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import { detectSingleFaceOrThrow } from "../services/faceRecognition.service.js";
import { assessImageQuality, assessFaceDistance } from "../utility/imageQuality.js";
import { encryptFaceDescriptor } from "../utility/faceEncryption.js";
import { uploadImageToLocalStorage } from "../utils/localStorageUtils.js";

const VALID_POSES = ["FRONT", "LEFT", "RIGHT", "UP", "DOWN"];
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

export const registerFaceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: VALID_POSES.length },
  fileFilter: (req, file, cb) => {
    const ok = ALLOWED_MIME_TYPES.includes(file.mimetype);
    cb(ok ? null : new AppError("Only JPG/PNG/WEBP images are allowed", 400), ok);
  },
}).array("photos", VALID_POSES.length);

/** multer strips the `[]` suffix from repeated multipart field names (verified empirically). */
function normalizePoses(body) {
  const raw = body?.poses ?? body?.["poses[]"];
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((p) => String(p).toUpperCase().trim());
}

/**
 * POST /api/v1/face-attendance/register-face
 * Accepts exactly 5 photos (one per pose) in a single multipart request,
 * validates image quality + exactly-one-face + framing for each, then
 * stores AES-256-GCM encrypted descriptors — never raw biometric vectors,
 * and raw selfies only when ENABLE_RAW_FACE_STORAGE=true.
 */
export const registerFace = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.user._id);
  if (!user) return next(new AppError("User not found", 404));

  if (user.faceRegistrationStatus === "REGISTERED") {
    return next(
      new AppError(
        "Face is already registered for this account. Ask an admin to reset your registration before re-registering.",
        409
      )
    );
  }

  const files = req.files || [];
  const poses = normalizePoses(req.body);

  if (files.length !== VALID_POSES.length || poses.length !== VALID_POSES.length) {
    return next(
      new AppError(
        `Exactly ${VALID_POSES.length} photos with matching poses (${VALID_POSES.join(", ")}) are required in one request.`,
        400
      )
    );
  }

  const posesSet = new Set(poses);
  const posesValid = posesSet.size === VALID_POSES.length && [...posesSet].every((p) => VALID_POSES.includes(p));
  if (!posesValid) {
    return next(new AppError(`Poses must be exactly one each of: ${VALID_POSES.join(", ")}`, 400));
  }

  user.faceRegistrationStatus = "IN_PROGRESS";
  await user.save({ validateBeforeSave: false });

  const enableRawStorage = process.env.ENABLE_RAW_FACE_STORAGE === "true";
  const registeredPoses = [];

  // Sequential on purpose: WASM inference is single-threaded/CPU-bound, so running these
  // concurrently would only interleave work on one core while multiplying peak memory use.
  for (let i = 0; i < VALID_POSES.length; i += 1) {
    const pose = poses[i];
    const file = files[i];

    // One decode per photo, reused for both the quality heuristics and detection.
    const quality = await assessImageQuality(file.buffer);
    if (!quality.ok) {
      return next(new AppError(`Photo for pose ${pose} failed quality check (${quality.reason}). Please retake it.`, 422));
    }

    const { detection, imageWidth, imageHeight } = await detectSingleFaceOrThrow(quality.prepared).catch((err) => {
      err.message = `Photo for pose ${pose}: ${err.message}`;
      throw err;
    });

    const distanceCheck = assessFaceDistance(detection.detection.box, imageWidth, imageHeight);
    if (!distanceCheck.ok) {
      return next(new AppError(`Photo for pose ${pose} failed framing check (${distanceCheck.reason}). Please retake it.`, 422));
    }

    const { encryptedVector, iv, authTag } = encryptFaceDescriptor(detection.descriptor);

    let sourceImageUrl = null;
    if (enableRawStorage) {
      const uploadResult = await uploadImageToLocalStorage(file.buffer, `face-registrations/${user._id}`, {
        mimetype: file.mimetype,
      });
      if (uploadResult.success) sourceImageUrl = uploadResult.url;
    }

    await FaceEmbedding.findOneAndUpdate(
      { user: user._id, pose },
      {
        user: user._id,
        pose,
        encryptedVector,
        iv,
        authTag,
        qualityScore: Math.min(1, distanceCheck.faceAreaRatio * 2),
        sourceImageUrl,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    registeredPoses.push({ pose, qualityScore: Math.min(1, distanceCheck.faceAreaRatio * 2) });
  }

  user.faceRegistrationStatus = "REGISTERED";
  await user.save({ validateBeforeSave: false });

  return res.status(200).json(
    generateResponse(
      "Success",
      "Face registered successfully for all 5 poses.",
      {
        faceRegistrationStatus: user.faceRegistrationStatus,
        poses: registeredPoses,
      },
      undefined
    )
  );
});
