/**
 * Need-sow only: accepted unsown orders.
 * DISPATCHED, COMPLETED, FARM_READY, READY_FOR_DISPATCH, DISPATCH_PROCESS are not counted.
 */
export const NEED_SOW_ORDER_STATUSES = ["ACCEPTED"];

export const NEED_SOW_ORDER_STATUS_SET = new Set(NEED_SOW_ORDER_STATUSES);

/** Sowing Gap Analysis → Not sown tab (pre-dispatch pipeline, not finished dispatch). */
export const UNSOWN_SOW_BOARD_STATUSES = [
  "ACCEPTED",
  "ASSIGNED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
];

export const UNSOWN_SOW_BOARD_STATUS_SET = new Set(UNSOWN_SOW_BOARD_STATUSES);

/**
 * Orders counted toward remaining-to-dispatch pipeline (not need-sow).
 * Excludes DISPATCHED, COMPLETED, CANCELLED, TEMPORARY_CANCELLED, REJECTED, etc.
 */
export const SOWING_GAP_PIPELINE_STATUSES = [
  "ACCEPTED",
  "READY_FOR_DISPATCH",
  "PENDING",
  "DISPATCH_PROCESS",
];

export const SOWING_GAP_PIPELINE_STATUS_SET = new Set(SOWING_GAP_PIPELINE_STATUSES);

export function isSowingGapPipelineOrder(order) {
  if (!order?.orderStatus) return false;
  const excluded = new Set([
    "CANCELLED",
    "REJECTED",
    "TEMPORARY_CANCELLED",
    "DISPATCHED",
    "COMPLETED",
  ]);
  if (excluded.has(order.orderStatus)) return false;
  return SOWING_GAP_PIPELINE_STATUS_SET.has(order.orderStatus);
}
