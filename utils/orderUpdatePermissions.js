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
  const isDispatchManagerUser =
    user.role === "DISPATCH_MANAGER" || user.jobTitle === "DISPATCH_MANAGER";

  const canEditOrderCore =
    ["OFFICE_ADMIN", "SUPER_ADMIN", "ACCOUNTANT"].includes(userRole) ||
    isDispatchManagerUser;

  const canChangeOrderStatusFull =
    userRole === "SUPERADMIN" ||
    userRole === "SUPER_ADMIN" ||
    userRole === "OFFICE_ADMIN";

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

/**
 * Plain user object for permission checks. If the JWT says DISPATCH_MANAGER but the DB user
 * document does not (stale profile), align to dispatch so PATCH matches the signed session.
 *
 * @param {{ user?: import("mongoose").Document & { role?: string; jobTitle?: string }; token?: string } | null} req
 */
export function resolveUserForOrderUpdatePermissions(req) {
  const u = req?.user;
  if (!u) return null;
  const plain =
    typeof u.toObject === "function" ? u.toObject() : { ...u };
  if (!req?.token) return plain;
  try {
    const d = verifyAccessToken(req.token);
    const tokenSaysDispatch =
      d.role === "DISPATCH_MANAGER" || d.jobTitle === "DISPATCH_MANAGER";
    const ctx = getOrderUpdateUserContext(plain);
    if (tokenSaysDispatch && !ctx.isDispatchManagerUser) {
      return {
        ...plain,
        role: "DISPATCH_MANAGER",
        jobTitle: "DISPATCH_MANAGER",
      };
    }
  } catch {
    /* invalid token — fall back to DB-only */
  }
  return plain;
}
