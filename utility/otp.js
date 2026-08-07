import crypto from "crypto";

const OTP_LENGTH = 6;
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_VERIFY_ATTEMPTS = 5;

/** Cryptographically-random numeric OTP (avoids Math.random's predictability). */
export function generateOtp(length = OTP_LENGTH) {
  const max = 10 ** length;
  const value = crypto.randomInt(0, max);
  return String(value).padStart(length, "0");
}

export function hashOtp(otp) {
  return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

export function otpExpiryDate() {
  return new Date(Date.now() + OTP_TTL_MS);
}

export function isOtpExpired(expiresAt) {
  return !expiresAt || new Date(expiresAt).getTime() < Date.now();
}

export { MAX_VERIFY_ATTEMPTS };
