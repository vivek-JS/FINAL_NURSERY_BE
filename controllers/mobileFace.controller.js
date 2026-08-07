import multer from "multer";
import mongoose from "mongoose";
import User from "../models/user.model.js";
import EmployeeFaceProfile from "../models/employeeFaceProfile.model.js";
import AppError from "../utility/appError.js";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import { encryptFaceDescriptor } from "../utility/faceEncryption.js";
import { uploadImageToLocalStorage } from "../utils/localStorageUtils.js";
import {
  registerFaceEmbeddings,
  checkDuplicateFace,
  FaceServiceError,
} from "../services/faceServiceClient.js";
import { decryptProfileEmbedding } from "../utility/faceProfileUtils.js";

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const MIN_FRAMES = 3;
const MAX_FRAMES = 5;

export const registerFaceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: MAX_FRAMES },
  fileFilter: (_req, file, cb) => {
    const ok = ALLOWED_MIME_TYPES.includes(file.mimetype);
    cb(ok ? null : new AppError("Only JPG/PNG/WEBP images are allowed", 400), ok);
  },
}).array("image", MAX_FRAMES);

/**
 * POST /api/v1/mobile/face/register
 */
export const registerFace = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.user._id);
  if (!user) return next(new AppError("User not found", 404));

  if (user.faceRegistrationStatus === "REGISTERED") {
    return res.status(409).json({
      status: false,
      message: "Face is already registered for this account.",
      error_code: "FACE_ALREADY_REGISTERED",
    });
  }

  const files = req.files || [];
  if (files.length < MIN_FRAMES || files.length > MAX_FRAMES) {
    return next(new AppError(`Provide ${MIN_FRAMES} to ${MAX_FRAMES} face images.`, 400));
  }

  if (req.body.consent !== "true" && !user.faceConsentAt) {
    return next(new AppError("Face data consent is required before registration.", 400));
  }

  const buffers = files.map((f) => f.buffer);
  const deviceId = req.body.device_id || null;

  try {
    const activeProfiles = await EmployeeFaceProfile.find({ is_active: true }).lean();
    if (activeProfiles.length > 0) {
      const existing = activeProfiles.map((p) => ({
        employee_id: String(p.employee_id),
        embedding: decryptProfileEmbedding(p),
      }));
      const dupCheck = await checkDuplicateFace(buffers, existing);
      if (dupCheck.is_duplicate && String(dupCheck.matched_employee_id) !== String(user._id)) {
        return res.status(409).json({
          status: false,
          message: "This face is already registered to another employee.",
          error_code: "DUPLICATE_FACE",
        });
      }
    }

    user.faceRegistrationStatus = "IN_PROGRESS";
    if (req.body.consent === "true") user.faceConsentAt = new Date();
    await user.save({ validateBeforeSave: false });

    const result = await registerFaceEmbeddings(buffers, String(user._id));
    const embedding = new Float32Array(result.embedding);
    const { encryptedVector, iv, authTag } = encryptFaceDescriptor(embedding);

    let referenceImageUrl = null;
    if (process.env.ENABLE_RAW_FACE_STORAGE === "true" && files[0]) {
      const uploadResult = await uploadImageToLocalStorage(files[0].buffer, `face-registrations/${user._id}`, {
        mimetype: files[0].mimetype,
      });
      if (uploadResult.success) referenceImageUrl = uploadResult.url;
    }

    await EmployeeFaceProfile.updateMany({ employee_id: user._id }, { $set: { is_active: false } });

    await EmployeeFaceProfile.create({
      employee_id: user._id,
      face_embedding_enc: encryptedVector,
      iv,
      authTag,
      model_name: result.model_name || "InsightFace",
      model_version: result.model_version || "buffalo_l",
      embedding_dim: result.embedding?.length || 512,
      quality_score: result.quality_score,
      reference_image_url: referenceImageUrl,
      face_registered: true,
      registration_device_id: deviceId,
      registered_by: user._id,
      registered_at: new Date(),
      is_active: true,
    });

    user.faceRegistrationStatus = "REGISTERED";
    await user.save({ validateBeforeSave: false });

    return res.status(200).json({
      status: true,
      message: "Face registered successfully",
      data: {
        face_registered: true,
        faceRegistrationStatus: user.faceRegistrationStatus,
        quality_score: result.quality_score,
      },
    });
  } catch (err) {
    user.faceRegistrationStatus = "NOT_REGISTERED";
    await user.save({ validateBeforeSave: false });

    if (err instanceof FaceServiceError) {
      return res.status(422).json({
        status: false,
        message: err.message,
        error_code: err.errorCode || "FACE_NOT_DETECTED",
      });
    }
    throw err;
  }
});

/**
 * GET /api/v1/mobile/face/profile
 */
export const getFaceProfile = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).select("faceRegistrationStatus faceConsentAt employeeCode name");
  const profile = await EmployeeFaceProfile.findOne({ employee_id: req.user._id, is_active: true })
    .select("face_registered quality_score model_name model_version registered_at registration_device_id")
    .lean();

  return res.status(200).json({
    status: true,
    message: "Face profile fetched",
    data: {
      faceRegistrationStatus: user?.faceRegistrationStatus || "NOT_REGISTERED",
      face_registered: !!profile?.face_registered,
      quality_score: profile?.quality_score ?? null,
      model_name: profile?.model_name ?? null,
      model_version: profile?.model_version ?? null,
      registered_at: profile?.registered_at ?? null,
      employee_code: user?.employeeCode ?? null,
      employee_name: user?.name ?? null,
      face_consent_at: user?.faceConsentAt ?? null,
    },
  });
});
