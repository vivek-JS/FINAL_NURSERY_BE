import generateResponse from "../utility/responseFormat.js";

const INSIGHTS_ACCESS_ROLES = new Set([
  "SUPER_ADMIN",
  "SUPERADMIN",
  "ADMIN",
  "OFFICE_ADMIN",
  "OFFICEADMIN",
  "ACCOUNTANT",
  "CASHIER",
  "DISPATCH_MANAGER",
  "SALES",
  "DEALER",
]);

const SCOPED_INSIGHTS_ROLES = new Set(["SALES", "DEALER"]);

export function normalizeRoleKey(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function userRoleKeys(user) {
  return [normalizeRoleKey(user?.jobTitle), normalizeRoleKey(user?.role)].filter(Boolean);
}

export function userHasInsightsAccess(user) {
  return userRoleKeys(user).some((role) => INSIGHTS_ACCESS_ROLES.has(role));
}

export function isSalesOrDealerInsightsUser(user) {
  return userRoleKeys(user).some((role) => SCOPED_INSIGHTS_ROLES.has(role));
}

export function scopedInsightsRole(user) {
  return userRoleKeys(user).find((role) => SCOPED_INSIGHTS_ROLES.has(role)) || "";
}

export function requireInsightsAccess(req, res, next) {
  if (!req.user) {
    return res
      .status(401)
      .json(generateResponse("error", "Authentication required", null, null));
  }

  if (!userHasInsightsAccess(req.user)) {
    return res
      .status(403)
      .json(generateResponse("error", "Insufficient permissions", null, null));
  }

  const scopeRole = scopedInsightsRole(req.user);
  if (scopeRole) {
    req.user.jobTitle = scopeRole;
  }

  return next();
}
