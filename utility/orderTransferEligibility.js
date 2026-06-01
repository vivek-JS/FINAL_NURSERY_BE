/** Order statuses blocked from plant payment transfer (create + approve). */
export const ORDER_TRANSFER_EXCLUDED_STATUSES = [
  "DISPATCHED",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "CANCELLED",
  "REJECTED",
];

/** GET /order/getOrders `status` query for transfer order search (comma-separated). */
export const ORDER_TRANSFER_SEARCH_STATUS_QUERY = [
  "PENDING",
  "ACCEPTED",
  "ASSIGNED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
].join(",");

/**
 * @param {{ orderStatus?: string }|string|null|undefined} orderOrStatus
 * @returns {boolean}
 */
export function isOrderEligibleForPlantTransfer(orderOrStatus) {
  const st =
    typeof orderOrStatus === "string"
      ? orderOrStatus
      : String(orderOrStatus?.orderStatus || "");
  const normalized = st.trim().toUpperCase();
  if (!normalized) return false;
  return !ORDER_TRANSFER_EXCLUDED_STATUSES.includes(normalized);
}

/** Human-readable reason when transfer is blocked (for API errors). */
export function getOrderTransferIneligibilityMessage(order, role = "order") {
  const st = String(order?.orderStatus || order || "").trim().toUpperCase();
  const num = order?.orderId != null ? ` #${order.orderId}` : "";
  const label = role === "source" ? "Source" : role === "target" ? "Target" : "Order";
  if (!st) {
    return `${label} order${num} has no status; transfer is not allowed.`;
  }
  if (ORDER_TRANSFER_EXCLUDED_STATUSES.includes(st)) {
    return (
      `${label} order${num} is ${st}. Only remaining orders may transfer payments ` +
      `(not dispatched, completed, partially completed, cancelled, or rejected).`
    );
  }
  return null;
}

export function assertOrdersEligibleForPlantTransfer(sourceOrder, targetOrder) {
  const sourceMsg = getOrderTransferIneligibilityMessage(sourceOrder, "source");
  if (sourceMsg) {
    const err = new Error(sourceMsg);
    err.statusCode = 400;
    throw err;
  }
  const targetMsg = getOrderTransferIneligibilityMessage(targetOrder, "target");
  if (targetMsg) {
    const err = new Error(targetMsg);
    err.statusCode = 400;
    throw err;
  }
}

/** Dealer bulk order or farmer order booked under a dealer account. */
export function orderBelongsToDealerScope(order) {
  if (!order || typeof order !== "object") return false;
  if (order.dealerOrder === true) return true;
  if (order.dealer != null && String(order.dealer).trim() !== "") return true;
  const sp = order.salesPerson;
  if (sp && String(sp.jobTitle || "").toUpperCase() === "DEALER") return true;
  return false;
}

export function resolveDealerIdForOrder(order) {
  if (!order) return null;
  if (order.dealer != null && String(order.dealer).trim() !== "") {
    return String(order.dealer._id || order.dealer).trim();
  }
  const sp = order.salesPerson;
  if (sp && String(sp.jobTitle || "").toUpperCase() === "DEALER") {
    return String(sp._id || sp).trim();
  }
  return null;
}

/** Same dealer account — includes farmer orders with dealer/salesPerson DEALER (dealerOrder may be false). */
export function isDealerScopedTransferPair(fromOrder, toOrder) {
  const fromDealer = resolveDealerIdForOrder(fromOrder);
  const toDealer = resolveDealerIdForOrder(toOrder);
  return Boolean(fromDealer && toDealer && fromDealer === toDealer);
}
