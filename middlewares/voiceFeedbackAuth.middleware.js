import generateResponse from "../utility/responseFormat.js";

const ALLOWED = new Set([
  "SUPER_ADMIN",
  "SUPERADMIN",
  "OFFICE_ADMIN",
  "ADMIN",
]);

/**
 * Dashboard + manual call controls for voice feedback.
 */
export const requireVoiceFeedbackAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json(generateResponse("error", "Authentication required", null, null));
  }
  const candidates = [req.user.role, req.user.jobTitle].filter(Boolean);
  const ok = candidates.some((c) => ALLOWED.has(String(c).toUpperCase()));
  if (!ok) {
    return res.status(403).json(generateResponse("error", "Insufficient permissions", null, null));
  }
  next();
};
