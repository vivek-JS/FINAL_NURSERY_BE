export const ACTIVE_SOWING_ORDER_STATUSES = [
  "PENDING",
  "PROCESSING",
  "ACCEPTED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
];

export function validateLinkedOrderScope({
  requestedOrderIds = [],
  orders = [],
  plantId,
  subtypeId,
}) {
  const requested = [...new Set(requestedOrderIds.map(String))];
  const foundIds = new Set(orders.map((order) => String(order._id)));
  const missingOrderIds = requested.filter((id) => !foundIds.has(id));

  if (missingOrderIds.length) {
    return {
      valid: false,
      message: "One or more selected orders no longer exist",
      missingOrderIds,
    };
  }

  const mismatchedOrderIds = orders
    .filter(
      (order) =>
        String(order.plantName) !== String(plantId) ||
        String(order.plantSubtype) !== String(subtypeId)
    )
    .map((order) => String(order._id));
  if (mismatchedOrderIds.length) {
    return {
      valid: false,
      message: "Selected orders do not match the requested plant and subtype",
      mismatchedOrderIds,
    };
  }

  const ineligibleOrderIds = orders
    .filter(
      (order) =>
        order.sowingDone === true ||
        !ACTIVE_SOWING_ORDER_STATUSES.includes(order.orderStatus)
    )
    .map((order) => String(order._id));
  if (ineligibleOrderIds.length) {
    return {
      valid: false,
      message: "One or more selected orders are no longer eligible for sowing",
      ineligibleOrderIds,
    };
  }

  return {
    valid: true,
    linkedSlotIds: [
      ...new Set(
        orders.map((order) => String(order.bookingSlot || "")).filter(Boolean)
      ),
    ],
  };
}
