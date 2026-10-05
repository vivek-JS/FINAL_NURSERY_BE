import mongoose from "mongoose";
import AppError from "../utility/appError.js";

const BATCH_SOURCES = new Set(["vehicle_load", "shed_stock", "manual"]);

function normalizeStr(v) {
  return v != null ? String(v).trim() : "";
}

export function isBananaPlantOrder(order) {
  if (!order) return false;
  const line0 = Array.isArray(order?.plantLineItems) ? order.plantLineItems[0] : null;
  const plantBits = [
    order?.plantName?.name,
    order?.plantType?.name,
    order?.plantDetails?.name,
    order?.plantDetails?.subtype,
    typeof order?.plantName === "string" ? order.plantName : "",
    order?.plantSubtype?.name,
    typeof order?.plantSubtype === "string" ? order.plantSubtype : "",
    order?.productName,
    order?.plantNameSnapshot,
    order?.plantSubtypeSnapshot,
    line0?.plantNameSnapshot,
    line0?.plantSubtypeSnapshot,
  ];
  return /banana|keli|केळ/i.test(plantBits.filter(Boolean).join(" "));
}

function emptyManualSnapshot() {
  return {
    batchNumber: "",
    pollyhouse: "",
    source: "manual",
    capturedAt: new Date(),
  };
}

function validOid(v) {
  const s = normalizeStr(v);
  return s && mongoose.isValidObjectId(s) ? s : null;
}

export function dispatchDetailForOrder(dispatch, orderId) {
  const oid = normalizeStr(orderId);
  if (!oid || !Array.isArray(dispatch?.orderDispatchDetails)) return null;
  return (
    dispatch.orderDispatchDetails.find((row) => {
      const rid = normalizeStr(row?.orderId?._id ?? row?.orderId);
      return rid === oid;
    }) || null
  );
}

function snapshotFromVehicleBatch(entry) {
  if (!entry) return null;
  const batchNumber = normalizeStr(entry.batchNumber);
  if (!batchNumber) return null;
  return {
    batchNumber,
    batchId: validOid(entry.batchId) || undefined,
    pollyhouse: normalizeStr(entry.pollyhouse),
    secondaryInwardId: validOid(entry.secondaryInwardId) || undefined,
    source: "vehicle_load",
  };
}

/**
 * Resolve and validate batch/shed for delivery complete.
 * @returns {{ batchNumber, batchId?, pollyhouse, secondaryInwardId?, source, capturedAt: Date }}
 */
export function resolveCompleteDispatchBatch({
  dispatch,
  orderId,
  order = null,
  clientPayload = {},
} = {}) {
  const detail = dispatchDetailForOrder(dispatch, orderId);
  const loaded = Array.isArray(detail?.shedLoadedBatches)
    ? detail.shedLoadedBatches.filter((b) => normalizeStr(b?.batchNumber))
    : [];
  const banana = isBananaPlantOrder(order);

  const clientBatch = normalizeStr(clientPayload.batchNumber);
  const clientPolly = normalizeStr(clientPayload.pollyhouse);
  const clientSource = normalizeStr(clientPayload.batchSource).toLowerCase();

  if (loaded.length === 1) {
    const snap = snapshotFromVehicleBatch(loaded[0]);
    if (!snap) {
      throw new AppError("Vehicle load batch is missing batch number", 400);
    }
    return { ...snap, capturedAt: new Date() };
  }

  if (loaded.length > 1) {
    const match = loaded.find((b) => {
      if (normalizeStr(b.batchNumber) !== clientBatch) return false;
      const ph = normalizeStr(b.pollyhouse);
      if (!ph) return true;
      return !clientPolly || ph === clientPolly;
    });
    if (!match) {
      throw new AppError(
        "Select a batch that was loaded from the shed app for this order",
        400
      );
    }
    const snap = snapshotFromVehicleBatch(match);
    return { ...snap, capturedAt: new Date() };
  }

  if (!clientBatch) {
    if (order != null && !banana) {
      return emptyManualSnapshot();
    }
    throw new AppError(
      banana
        ? "Batch number is required to complete banana delivery"
        : "Batch number is required to complete delivery",
      400
    );
  }

  const source = BATCH_SOURCES.has(clientSource)
    ? clientSource
    : clientPayload.batchId || clientPayload.secondaryInwardId
      ? "shed_stock"
      : "manual";

  if (banana && source === "manual") {
    throw new AppError(
      "Banana delivery requires selecting an existing lagwad batch",
      400
    );
  }

  const batchId = validOid(clientPayload.batchId);
  const secondaryInwardId = validOid(clientPayload.secondaryInwardId);

  if (clientPayload.batchId != null && normalizeStr(clientPayload.batchId) && !batchId) {
    throw new AppError("Invalid batchId", 400);
  }
  if (
    clientPayload.secondaryInwardId != null &&
    normalizeStr(clientPayload.secondaryInwardId) &&
    !secondaryInwardId
  ) {
    throw new AppError("Invalid secondaryInwardId", 400);
  }

  if (clientPayload.requiresPollyhouse && !clientPolly) {
    throw new AppError("Shed selection is required for this batch", 400);
  }

  return {
    batchNumber: clientBatch,
    ...(batchId ? { batchId } : {}),
    pollyhouse: clientPolly,
    ...(secondaryInwardId ? { secondaryInwardId } : {}),
    source,
    capturedAt: new Date(),
  };
}
