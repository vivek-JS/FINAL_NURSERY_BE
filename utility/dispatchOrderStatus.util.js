import AppError from "../utility/appError.js";
import { revertEarlyDispatch } from "../services/earlyDispatch.service.js";
import { getOrderUpdateUserContext, resolveUserForOrderUpdatePermissions } from "../utils/orderUpdatePermissions.js";

/**
 * Extra plants (beyond an order's remaining) each role may dispatch per order.
 * Overflow is pushed onto `additionalPlants` and lets the slot go negative.
 */
export const DISPATCH_EXTRA_QTY_BY_ROLE = {
  DISPATCH_MANAGER: 1000,
  SUPER_ADMIN: 1000,
  SUPERADMIN: 1000,
  OFFICE_ADMIN: 500,
  OFFICEADMIN: 500,
};

export const bookablePlantsTotal = (order) =>
  Number(order?.numberOfPlants || 0) + Number(order?.additionalPlants || 0);

export const orderRemainingOrBookable = (order) => {
  const rem = order?.remainingPlants;
  if (rem != null && Number.isFinite(Number(rem))) return Number(rem);
  return bookablePlantsTotal(order);
};

/** Status while dispatch is active or qty adjusted (not cancel). */
export function orderStatusFromRemaining(order, remaining) {
  const r = Number(remaining);
  if (!Number.isFinite(r)) {
    throw new AppError("Invalid remaining plants on order after dispatch update", 400);
  }
  if (r <= 0) return "DISPATCHED";
  const total = bookablePlantsTotal(order);
  if (r > total) {
    throw new AppError(
      `Remaining plants (${r}) exceeds bookable total (${total}) for order ${order?.orderId ?? ""}`,
      400
    );
  }
  if (r >= total) return "READY_FOR_DISPATCH";
  return "DISPATCH_PROCESS";
}

/** After dispatch cancel/delete — return to farm-ready queue, not ready-for-dispatch. */
export function orderStatusAfterDispatchCancel(order, remaining) {
  const r = Number(remaining);
  if (!Number.isFinite(r)) {
    throw new AppError("Invalid remaining plants on order after dispatch cancel", 400);
  }
  if (r <= 0) return "DISPATCHED";
  const total = bookablePlantsTotal(order);
  if (r >= total) return "FARM_READY";
  return "DISPATCH_PROCESS";
}

export function isDispatchManagerRequest(req) {
  const user = resolveUserForOrderUpdatePermissions(req);
  return Boolean(getOrderUpdateUserContext(user).isDispatchManagerUser);
}

function roleKey(r) {
  if (r == null || r === "") return "";
  return String(r).trim().toUpperCase().replace(/\s+/g, "_");
}

/** Extra-plant allowance for a user object. Checks role and jobTitle independently. */
export function dispatchExtraQtyForUser(user) {
  if (!user) return 0;
  const ctx = getOrderUpdateUserContext(user);
  if (ctx.isDispatchManagerUser) {
    return DISPATCH_EXTRA_QTY_BY_ROLE.DISPATCH_MANAGER;
  }
  const fromRole = DISPATCH_EXTRA_QTY_BY_ROLE[roleKey(user.role)] ?? 0;
  const fromJob = DISPATCH_EXTRA_QTY_BY_ROLE[roleKey(user.jobTitle)] ?? 0;
  return Math.max(fromRole, fromJob);
}

/** Extra-plant allowance for the requesting user, 0 when the role has none. */
export function dispatchExtraQtyForRequest(req) {
  const user = resolveUserForOrderUpdatePermissions(req);
  return dispatchExtraQtyForUser(user);
}

/** True when the requesting role may dispatch past an order's remaining plants. */
export function canDispatchBeyondRemaining(req) {
  return dispatchExtraQtyForRequest(req) > 0;
}

export function maxDispatchQuantityForOrder(currentRemaining, req) {
  const base = Number(currentRemaining) || 0;
  return base + dispatchExtraQtyForRequest(req);
}

export function assertDispatchQuantityAllowed(order, dispatchQuantity, req) {
  const qty = Number(dispatchQuantity) || 0;
  const currentRemaining = orderRemainingOrBookable(order);
  const maxAllowed = maxDispatchQuantityForOrder(currentRemaining, req);
  if (qty > maxAllowed) {
    throw new AppError(
      `Dispatch quantity (${qty}) exceeds allowed plants (${maxAllowed}) for order ${order.orderId}`,
      400
    );
  }
  return { currentRemaining, maxAllowed, qty };
}

/** Build $set / $unset fields when reverting an order after dispatch cancel/remove. */
export async function buildDispatchCancelRevertSet(order, restoredRemaining, session, userId) {
  const nextStatus = orderStatusAfterDispatchCancel(order, restoredRemaining);
  // Clear day-key via $unset — schema enum rejects `null`.
  const setFields = {
    remainingPlants: restoredRemaining,
    orderStatus: nextStatus,
  };
  const unsetFields = {
    dispatchDayKey: 1,
    dispatchTargetDate: 1,
  };

  const filteredBody = { ...setFields };
  await revertEarlyDispatch({
    order,
    session,
    filteredBody,
    userId,
  });

  Object.assign(setFields, filteredBody);
  delete setFields.__earlyDispatchSlotHandled;
  // Ensure early-dispatch helpers cannot reintroduce invalid null enums.
  delete setFields.dispatchDayKey;
  delete setFields.dispatchTargetDate;

  return { nextStatus, setFields, unsetFields };
}
