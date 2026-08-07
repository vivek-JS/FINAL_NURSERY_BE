import rateLimit from "express-rate-limit";
import generateResponse from "../utility/responseFormat.js";

/**
 * Rate limiters scoped ONLY to the new face-attendance-related auth/biometric
 * endpoints (login, forgot/reset-password, register-face, verify-face). No
 * existing route's behavior changes — `express-rate-limit` was already an
 * installed-but-unused dependency, so this only adds guards to new attack
 * surface introduced by the attendance app.
 */
const rateLimitedJson = (message) => (req, res) => {
  res.status(429).json(generateResponse("error", message, null, null));
};

/** Login: generous enough for real users retrying a typo, tight enough to slow credential stuffing. */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `login:${req.ip}:${req.body?.phoneNumber || ""}`,
  handler: rateLimitedJson("Too many login attempts. Please try again in a few minutes."),
});

/** Forgot/reset password: OTPs are short-lived and low-entropy (6 digits), so brute force must be throttled hard. */
export const passwordResetRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `pwreset:${req.ip}:${req.body?.phoneNumber || ""}`,
  handler: rateLimitedJson("Too many password reset attempts. Please try again later."),
});

/** Face registration/verification: expensive (WASM inference) + biometric, so cap per-IP call rate. */
export const faceOperationRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `face:${req.ip}:${req.user?._id || ""}`,
  handler: rateLimitedJson("Too many face recognition requests. Please slow down and try again."),
});
