import AppError from "../utility/appError.js";

export const bookablePlantsTotal = (order) =>
  Number(order?.numberOfPlants || 0) + Number(order?.additionalPlants || 0);

export const orderRemainingOrBookable = (order) => {
  const rem = order?.remainingPlants;
  if (rem != null && Number.isFinite(Number(rem))) return Number(rem);
  return bookablePlantsTotal(order);
};

/** Remaining plants after nursery dispatch leg: 0 = fully out, full bookable = ready queue. */
export const orderStatusFromRemaining = (order, remaining) => {
  const r = Number(remaining);
  if (!Number.isFinite(r) || r < 0) {
    throw new AppError("Invalid remaining plants on order after dispatch update", 400);
  }
  if (r === 0) return "DISPATCHED";
  const total = bookablePlantsTotal(order);
  if (r > total) {
    throw new AppError(
      `Remaining plants (${r}) exceeds bookable total (${total}) for order ${order?.orderId ?? ""}`,
      400
    );
  }
  if (r >= total) return "READY_FOR_DISPATCH";
  return "DISPATCH_PROCESS";
};

export const orderStatusForCurrentRemaining = (order) =>
  orderStatusFromRemaining(order, orderRemainingOrBookable(order));

export const buildDispatchLinkClearedOrderPatch = (
  order,
  { clearCurrentDispatchId = false } = {}
) => {
  const patch = {
    orderStatus: orderStatusForCurrentRemaining(order),
  };

  if (clearCurrentDispatchId) {
    patch.currentDispatchId = null;
  }

  return patch;
};
