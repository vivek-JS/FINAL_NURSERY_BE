import bcrypt from "bcryptjs";
import User from "../models/user.model.js";
import AppError from "../utility/appError.js";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import { generateOtp, hashOtp, otpExpiryDate, isOtpExpired, MAX_VERIFY_ATTEMPTS } from "../utility/otp.js";
import { sendPasswordResetOtp } from "../utility/otpDelivery.js";

/**
 * POST /api/v1/user/forgot-password  { phoneNumber }
 * Always responds 200 with a generic message (never reveals whether the
 * phone number is registered) to avoid user enumeration.
 */
export const forgotPassword = catchAsync(async (req, res, next) => {
  const phoneNumber = Number(req.body?.phoneNumber);
  if (!req.body?.phoneNumber || Number.isNaN(phoneNumber)) {
    return next(new AppError("Valid phone number is required", 400));
  }

  const genericResponse = generateResponse(
    "Success",
    "If an account exists for this phone number, a reset code has been sent.",
    { phoneNumber },
    undefined
  );

  const user = await User.findOne({ phoneNumber, isDisabled: { $ne: true } });
  if (!user) {
    // Same response as the success path — do not leak account existence.
    return res.status(200).json(genericResponse);
  }

  const otp = generateOtp();
  user.passwordResetOtpHash = hashOtp(otp);
  user.passwordResetOtpExpiresAt = otpExpiryDate();
  user.passwordResetOtpAttempts = 0;
  await user.save({ validateBeforeSave: false });

  const delivery = await sendPasswordResetOtp(phoneNumber, otp);

  return res.status(200).json(
    generateResponse(
      "Success",
      "If an account exists for this phone number, a reset code has been sent.",
      {
        phoneNumber,
        // Only surfaced when WhatsApp delivery isn't configured, so QA/dev builds are unblocked.
        devOtp: delivery.delivered ? undefined : otp,
      },
      undefined
    )
  );
});

/**
 * POST /api/v1/user/reset-password  { phoneNumber, otp, newPassword }
 */
export const resetPasswordWithOtp = catchAsync(async (req, res, next) => {
  const phoneNumber = Number(req.body?.phoneNumber);
  const { otp, newPassword } = req.body || {};

  if (!req.body?.phoneNumber || Number.isNaN(phoneNumber)) {
    return next(new AppError("Valid phone number is required", 400));
  }
  if (!otp) {
    return next(new AppError("OTP is required", 400));
  }
  if (!newPassword || newPassword.length < 6) {
    return next(new AppError("New password must be at least 6 characters", 400));
  }

  const user = await User.findOne({ phoneNumber }).select(
    "+passwordResetOtpHash +passwordResetOtpExpiresAt +passwordResetOtpAttempts"
  );

  if (!user || !user.passwordResetOtpHash) {
    return next(new AppError("Invalid or expired reset code", 400));
  }

  if (isOtpExpired(user.passwordResetOtpExpiresAt)) {
    user.passwordResetOtpHash = null;
    user.passwordResetOtpExpiresAt = null;
    await user.save({ validateBeforeSave: false });
    return next(new AppError("Reset code has expired. Please request a new one.", 400));
  }

  if (user.passwordResetOtpAttempts >= MAX_VERIFY_ATTEMPTS) {
    user.passwordResetOtpHash = null;
    user.passwordResetOtpExpiresAt = null;
    await user.save({ validateBeforeSave: false });
    return next(new AppError("Too many incorrect attempts. Please request a new reset code.", 429));
  }

  if (hashOtp(otp) !== user.passwordResetOtpHash) {
    user.passwordResetOtpAttempts += 1;
    await user.save({ validateBeforeSave: false });
    return next(new AppError("Incorrect reset code", 400));
  }

  user.password = await bcrypt.hash(newPassword, 10);
  user.isPasswordSet = true;
  user.passwordResetOtpHash = null;
  user.passwordResetOtpExpiresAt = null;
  user.passwordResetOtpAttempts = 0;
  await user.save({ validateBeforeSave: false });

  return res.status(200).json(
    generateResponse("Success", "Password reset successfully. Please log in with your new password.", null, undefined)
  );
});
