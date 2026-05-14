/**
 * Order PATCH /updateOrder permission helpers (kept testable and in sync with factory.controller).
 */

import { verifyAccessToken } from "../utility/jwtUtils.js";

/** Statuses a DISPATCH_MANAGER may set via updateOrder (narrow allowlist). */
export const DISPATCH_MANAGER_ALLOWED_STATUSES = new Set([
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
]);

/**
 * @param {import("mongoose").Document | { role?: string; jobTitle?: string } | null | undefined} user
 */
export function getOrderUpdateUserContext(user) {
  if (!user) {
    return {
      userRole: undefined,
      isDispatchManagerUser: false,
      canEditOrderCore: false,
      canChangeOrderStatusFull: false,
    };
  }

  const userRole = user.role || user.jobTitle;
  const ur = normalizeRoleKey(user.role || user.jobTitle);
  const isDispatchManagerUser =
    normalizeRoleKey(user.role) === "DISPATCH_MANAGER" ||
    normalizeRoleKey(user.jobTitle) === "DISPATCH_MANAGER";

  const canEditOrderCore =
    ["OFFICE_ADMIN", "OFFICEADMIN", "SUPER_ADMIN", "SUPERADMIN", "ACCOUNTANT"].includes(ur) ||
    isDispatchManagerUser;

  const canChangeOrderStatusFull =
    ur === "SUPERADMIN" ||
    ur === "SUPER_ADMIN" ||
    ur === "OFFICE_ADMIN" ||
    ur === "OFFICEADMIN";

  return {
    userRole,
    isDispatchManagerUser,
    canEditOrderCore,
    canChangeOrderStatusFull,
  };
}

export function isDispatchManagerAllowedStatus(orderStatus) {
  return DISPATCH_MANAGER_ALLOWED_STATUSES.has(orderStatus);
}

/** Normalize role/jobTitle for comparisons (case + spacing). */
function normalizeRoleKey(r) {
  if (r == null || r === "") return "";
  return String(r).trim().toUpperCase().replace(/\s+/g, "_");
}

/** Bearer token from Authorization header (req.token is rarely set by middleware). */
function extractBearerTokenFromReq(req) {
  if (req?.token != null && req.token !== "") {
    return typeof req.token === "string" ? req.token : null;
  }
  const h = req?.headers?.authorization ?? req?.headers?.Authorization;
  if (!h || typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/**
 * Plain user object for permission checks. If the JWT says DISPATCH_MANAGER but the DB user
 * document does not (stale profile), align to dispatch so PATCH matches the signed session.
 *
 * Same for OFFICE_ADMIN / SUPER_ADMIN / ACCOUNTANT: trust signed JWT when the DB profile is
 * stale, so salesPerson reassignment and status changes match what the user logged in as.
 *
 * @param {{ user?: import("mongoose").Document & { role?: string; jobTitle?: string }; token?: string; headers?: Record<string, string | undefined> } | null} req
 */
export function resolveUserForOrderUpdatePermissions(req) {
  const u = req?.user;
  if (!u) return null;
  const plain =
    typeof u.toObject === "function" ? u.toObject() : { ...u };
  const bearer = extractBearerTokenFromReq(req);
  if (!bearer) return plain;
  try {
    const d = verifyAccessToken(bearer);
    /** Prefer JWT role/jobTitle for PATCH checks whenever the access token verifies (DB profile may be stale). */
    let merged = {
      ...plain,
      ...(d.role != null && String(d.role).trim() !== "" ? { role: d.role } : {}),
      ...(d.jobTitle != null && String(d.jobTitle).trim() !== ""
        ? { jobTitle: d.jobTitle }
        : {}),
    };

    const ctxMerged = getOrderUpdateUserContext(merged);

    const tokenSaysDispatch =
      normalizeRoleKey(d.role) === "DISPATCH_MANAGER" ||
      normalizeRoleKey(d.jobTitle) === "DISPATCH_MANAGER";
    if (tokenSaysDispatch && !ctxMerged.isDispatchManagerUser) {
      merged = {
        ...merged,
        role: "DISPATCH_MANAGER",
        jobTitle: "DISPATCH_MANAGER",
      };
    }

    return merged;
  } catch {
    /* invalid token — fall back to DB-only */
  }
  return plain;
}
