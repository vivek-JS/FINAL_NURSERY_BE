import AppError from "../utility/appError.js";
import { revertEarlyDispatch } from "../services/earlyDispatch.service.js";
import { getOrderUpdateUserContext, resolveUserForOrderUpdatePermissions } from "../utils/orderUpdatePermissions.js";

/** Dispatch manager may dispatch up to remaining + this many extra plants per order. */
export const DISPATCH_MANAGER_EXTRA_QTY = 1000;

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

export function maxDispatchQuantityForOrder(currentRemaining, req) {
  const base = Number(currentRemaining) || 0;
  if (isDispatchManagerRequest(req)) {
    return base + DISPATCH_MANAGER_EXTRA_QTY;
  }
  return base;
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

/** Build $set fields when reverting an order after dispatch cancel/remove. */
export async function buildDispatchCancelRevertSet(order, restoredRemaining, session, userId) {
  const nextStatus = orderStatusAfterDispatchCancel(order, restoredRemaining);
  const setFields = {
    remainingPlants: restoredRemaining,
    orderStatus: nextStatus,
    dispatchDayKey: null,
    dispatchTargetDate: null,
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

  return { nextStatus, setFields };
}
