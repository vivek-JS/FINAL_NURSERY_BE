/**
 * After physical dispatch, align order.deliveryDate to the IST dispatch day
 * so slot cards (grouped by deliveryDate window) minus the old slot and plus the new one.
 */
import {
  formatIstYmd,
  isDateOutsideSlotWindow,
  normalizeDeliveryDateForStorage,
} from "./istCalendar.js";

export const POST_DISPATCH_STATUSES = new Set([
  "DISPATCHED",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
]);

export function isPostDispatchStatus(status) {
  return POST_DISPATCH_STATUSES.has(String(status || "").toUpperCase());
}

function firstValidDate(candidates) {
  for (const value of candidates) {
    if (value == null || value === "") continue;
    const d = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function earliestHistoryDate(entries, pick) {
  const dates = (entries || [])
    .map((entry) => pick(entry))
    .filter((value) => value != null && value !== "")
    .map((value) => (value instanceof Date ? value : new Date(value)))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  return dates[0] || null;
}

/**
 * Actual dispatch instant used for IST calendar comparison.
 */
export function resolveDispatchAt({
  previousOrder,
  updateOperation,
  setFields,
} = {}) {
  const push = updateOperation?.$push?.dispatchHistory;
  const pushDate =
    push && typeof push === "object" && !push.$each
      ? push.date
      : Array.isArray(push?.$each)
        ? push.$each[push.$each.length - 1]?.date
        : null;

  const setHist = setFields?.dispatchHistory ?? updateOperation?.$set?.dispatchHistory;
  const setHistDate = Array.isArray(setHist)
    ? setHist[setHist.length - 1]?.date
    : null;

  const earliestDispatchHistory = earliestHistoryDate(
    previousOrder?.dispatchHistory,
    (entry) => entry?.date
  );

  const firstDispatchedAt = earliestHistoryDate(
    previousOrder?.statusChanges,
    (entry) =>
      String(entry?.newStatus || "").toUpperCase() === "DISPATCHED"
        ? entry.createdAt
        : null
  );

  return (
    firstValidDate([
      pushDate,
      setHistDate,
      earliestDispatchHistory,
      firstDispatchedAt,
    ]) || new Date()
  );
}

export function shouldApplyDeliveryDateSync({
  previousStatus,
  nextStatus,
  previousDeliveryDate,
  dispatchAt,
} = {}) {
  if (!isPostDispatchStatus(nextStatus)) return false;

  const prev = String(previousStatus || "").toUpperCase();
  const next = String(nextStatus || "").toUpperCase();
  if (isPostDispatchStatus(prev) && prev === next) {
    return false;
  }

  const nextYmd = formatIstYmd(dispatchAt);
  if (!nextYmd) return false;
  const prevYmd = formatIstYmd(previousDeliveryDate);
  if (prevYmd && prevYmd === nextYmd) return false;
  return true;
}

export function buildDeliveryDateSyncFields(previousOrder, dispatchAt) {
  const deliveryDate = normalizeDeliveryDateForStorage(dispatchAt);
  if (!deliveryDate) return null;

  const fields = { deliveryDate };
  if (!previousOrder?.oldDeliveryDate && previousOrder?.deliveryDate) {
    fields.oldDeliveryDate = previousOrder.deliveryDate;
  }
  return fields;
}

export function shouldMoveSlotForDispatchDay(slotWindow, dispatchDate) {
  if (!slotWindow?.startDay || !slotWindow?.endDay) return false;
  return isDateOutsideSlotWindow(dispatchDate, slotWindow);
}

/**
 * Mutates setFields (Mongo $set or factory filteredBody).
 * Moves bookingSlot via applyEarlyDispatch when the dispatch day is outside the current window.
 */
export async function applyPostDispatchDeliveryDateSync({
  previousOrder,
  nextStatus,
  setFields,
  updateOperation,
  session,
  userId,
} = {}) {
  if (!previousOrder || !setFields) return { applied: false };

  const dispatchAt = resolveDispatchAt({
    previousOrder,
    updateOperation,
    setFields,
  });

  if (
    !shouldApplyDeliveryDateSync({
      previousStatus: previousOrder.orderStatus,
      nextStatus,
      previousDeliveryDate: previousOrder.deliveryDate,
      dispatchAt,
    })
  ) {
    return { applied: false };
  }

  const fields = buildDeliveryDateSyncFields(previousOrder, dispatchAt);
  if (!fields) return { applied: false };

  let movedSlot = false;
  if (previousOrder.quotaSource !== "dealer" && previousOrder.bookingSlot) {
    try {
      const { getSlotWindowById } = await import("./findDeliverySlot.js");
      const { applyEarlyDispatch } = await import(
        "../services/earlyDispatch.service.js"
      );
      const slotWindow = await getSlotWindowById(previousOrder.bookingSlot);
      if (shouldMoveSlotForDispatchDay(slotWindow, fields.deliveryDate)) {
        await applyEarlyDispatch({
          order: previousOrder,
          dispatchTargetDate: fields.deliveryDate,
          session,
          filteredBody: setFields,
          userId,
        });
        delete setFields.__earlyDispatchSlotHandled;
        movedSlot = Boolean(setFields.bookingSlot);
      }
    } catch (err) {
      console.error("Post-dispatch slot move skipped; deliveryDate still synced", {
        orderId: String(previousOrder?._id || previousOrder?.orderId || ""),
        error: err?.message || err,
      });
    }
  }

  if (!movedSlot) {
    Object.assign(setFields, fields);
  } else if (setFields.deliveryDate == null) {
    Object.assign(setFields, fields);
  }

  return { applied: true, movedSlot, deliveryDate: setFields.deliveryDate };
}
