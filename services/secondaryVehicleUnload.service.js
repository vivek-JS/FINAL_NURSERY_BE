import mongoose from "mongoose";
import AppError from "../utility/appError.js";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import Dispatch from "../models/dispatch.model.js";
import Order from "../models/order.model.js";
import {
  findDispatchActiveByIdOrTransport,
  unionDispatchOrderObjectIds,
  syncDispatchTransportStatusAfterShedChange,
  DISPATCH_SHED_ALLOWED_STATUSES,
} from "./secondaryVehicleLoad.service.js";
import { restoreSecondaryInwardSlotStock } from "./secondaryShedSlotStock.service.js";
import { recordSecondaryUnloadOnLedger } from "./secondaryDispatchAvailability.service.js";
import {
  recordShedActivity,
  SHED_ACTIVITY_ACTIONS,
} from "./shedActivity.service.js";
import { updateOrderWithLedgerSync } from "../controllers/dispatch.controller.js";

const BATCH_SELECT_FIELDS =
  "batchNumber dateAdded primaryPlantReadyDays secondaryPlantReadyDays isActive plantCmsId plantSubtypeId";

export { DISPATCH_SHED_ALLOWED_STATUSES };

export function assertDispatchShedOpsAllowed(dispatchDoc) {
  if (!dispatchDoc) throw new AppError("Vehicle dispatch not found", 404);
  if (!DISPATCH_SHED_ALLOWED_STATUSES.includes(dispatchDoc.transportStatus)) {
    throw new AppError(
      "Vehicle must be PENDING, IN_TRANSIT, or LOADED for shed operations",
      400
    );
  }
}

/** Aggregate secondary outward lines loaded onto a vehicle (optionally filtered by order). */
export async function collectLoadedOutwardLinesForDispatch(dispatchId, linkedOrderId) {
  if (!mongoose.isValidObjectId(String(dispatchId))) {
    return { lines: [], totalPlants: 0 };
  }
  const oid = new mongoose.Types.ObjectId(String(dispatchId));
  const orderFilter = linkedOrderId
    ? String(linkedOrderId)
    : null;

  const pos = await PlantOutward.find({
    "secondaryOutward.linkedDispatchId": oid,
  })
    .populate({ path: "batchId", select: "batchNumber" })
    .select("batchId secondaryInward secondaryOutward")
    .lean();

  const lines = [];
  let totalPlants = 0;

  for (const po of pos) {
    const batchId = po.batchId?._id ?? po.batchId;
    const batchNumber =
      po.batchId?.batchNumber != null ? String(po.batchId.batchNumber) : "";
    const inwardById = new Map(
      (po.secondaryInward || []).map((si) => [String(si._id), si])
    );

    for (const so of po.secondaryOutward || []) {
      if (String(so.linkedDispatchId) !== String(dispatchId)) continue;
      const plants = Math.max(0, Number(so.totalQuantity) || 0);
      if (plants < 1) continue;
      if (orderFilter && String(so.linkedOrderId || "") !== orderFilter) continue;

      const srcInward = so.sourceSecondaryInwardId
        ? inwardById.get(String(so.sourceSecondaryInwardId))
        : null;

      lines.push({
        batchId: String(batchId),
        batchNumber,
        plantOutwardId: String(po._id),
        secondaryOutwardId: String(so._id),
        secondaryInwardId: so.sourceSecondaryInwardId
          ? String(so.sourceSecondaryInwardId)
          : null,
        linkedOrderId: so.linkedOrderId ? String(so.linkedOrderId) : null,
        plants,
        size: so.size,
        cavity: so.cavity,
        pollyhouse: so.pollyhouse,
        secondaryInwardDate: srcInward?.secondaryInwardDate ?? null,
        linkedBookingSlotId: srcInward?.linkedBookingSlotId
          ? String(srcInward.linkedBookingSlotId)
          : null,
        dispatchFulfillmentSequence: so.dispatchFulfillmentSequence,
        loadedAt: so.secondaryOutwardDate,
      });
      totalPlants += plants;
    }
  }

  lines.sort(
    (a, b) =>
      (a.dispatchFulfillmentSequence || 0) - (b.dispatchFulfillmentSequence || 0)
  );

  return { lines, totalPlants };
}

export function normalizeOutwardUnloadSelections(raw) {
  if (!Array.isArray(raw)) return [];
  const byId = new Map();
  for (const sel of raw) {
    const oid = String(sel?.secondaryOutwardId || "").trim();
    const plants = Math.max(0, Math.floor(Number(sel?.plants) || 0));
    if (!oid || plants < 1) continue;
    const prev =
      byId.get(oid) || {
        secondaryOutwardId: oid,
        batchId: sel?.batchId != null ? String(sel.batchId) : "",
        plants: 0,
      };
    prev.plants += plants;
    if (!prev.batchId && sel?.batchId != null) prev.batchId = String(sel.batchId);
    byId.set(oid, prev);
  }
  return [...byId.values()];
}

async function executeOneSecondaryUnloadLine({
  session,
  batchId,
  secondaryOutwardId,
  plantsToUnload,
  linkedDispatchDoc,
  performedBy,
}) {
  const plantOutward = await PlantOutward.findOne({ batchId }).session(session);
  if (!plantOutward) {
    throw new AppError("No plant outward found with this batch ID", 404);
  }

  const outward = plantOutward.secondaryOutward.id(secondaryOutwardId);
  if (!outward) {
    throw new AppError("Secondary outward entry not found", 404);
  }
  if (String(outward.linkedDispatchId) !== String(linkedDispatchDoc._id)) {
    throw new AppError("Outward line is not linked to this vehicle dispatch", 400);
  }

  const currentPlants = Math.max(0, Number(outward.totalQuantity) || 0);
  const unloadQty = Math.max(0, Math.floor(Number(plantsToUnload) || 0));
  if (unloadQty < 1) {
    throw new AppError("Unload quantity must be at least 1", 400);
  }
  if (unloadQty > currentPlants) {
    throw new AppError(
      `Cannot unload ${unloadQty} — only ${currentPlants} on this line`,
      400
    );
  }

  const sourceInwardId = outward.sourceSecondaryInwardId;
  if (!sourceInwardId) {
    throw new AppError("Outward line missing source secondary inward", 400);
  }

  const secondaryInward = plantOutward.secondaryInward.id(sourceInwardId);
  if (!secondaryInward) {
    throw new AppError("Source secondary inward entry not found", 404);
  }

  const batchDoc = await DispatchBatch.findById(plantOutward.batchId)
    .select(BATCH_SELECT_FIELDS)
    .session(session)
    .lean();

  const siPlain =
    typeof secondaryInward.toObject === "function"
      ? secondaryInward.toObject()
      : secondaryInward;

  const cav = Math.max(1, Math.floor(Number(outward.cavity) || 126));
  const fullTrays = Math.floor(unloadQty / cav);
  const partialPlants = unloadQty - fullTrays * cav;
  const traysReturned = fullTrays + (partialPlants > 0 ? 1 : 0);

  const newInwardAvail = secondaryInward.availableQuantity + unloadQty;
  const inwardTotal = Math.max(
    Number(secondaryInward.totalQuantity) || 0,
    newInwardAvail
  );
  let newInwardStatus = "partially_transferred";
  if (newInwardAvail >= inwardTotal) newInwardStatus = "available";
  else if (newInwardAvail <= 0) newInwardStatus = "fully_transferred";

  const transferHistory = {
    transferDate: new Date(),
    quantityTransferred: unloadQty,
    remarks: "Vehicle unload — returned to shed",
  };

  const fullUnload = unloadQty >= currentPlants;

  if (fullUnload) {
    await PlantOutward.updateOne(
      { batchId, "secondaryInward._id": sourceInwardId },
      {
        $pull: { secondaryOutward: { _id: secondaryOutwardId } },
        $set: {
          "secondaryInward.$.availableQuantity": newInwardAvail,
          "secondaryInward.$.transferStatus": newInwardStatus,
        },
        $push: { "secondaryInward.$.transferHistory": transferHistory },
      },
      { session }
    );
  } else {
    const remaining = currentPlants - unloadQty;
    const remFullTrays = Math.floor(remaining / cav);
    const remPartial = remaining - remFullTrays * cav;
    const remTrays = remFullTrays + (remPartial > 0 ? 1 : 0);

    await PlantOutward.updateOne(
      {
        batchId,
        "secondaryInward._id": sourceInwardId,
        "secondaryOutward._id": secondaryOutwardId,
      },
      {
        $set: {
          "secondaryInward.$.availableQuantity": newInwardAvail,
          "secondaryInward.$.transferStatus": newInwardStatus,
          "secondaryOutward.$.totalQuantity": remaining,
          "secondaryOutward.$.numberOfPlants": remaining,
          "secondaryOutward.$.numberOfTrays": remTrays,
          "secondaryOutward.$.numberOfFullTrays": remFullTrays,
          "secondaryOutward.$.partialTrayPlants": remPartial,
        },
        $push: { "secondaryInward.$.transferHistory": transferHistory },
      },
      { session }
    );
  }

  let slotRestore = 0;
  try {
    const restoreResult = await restoreSecondaryInwardSlotStock({
      session,
      batchId,
      secondaryInwardId: sourceInwardId,
      batchLean: batchDoc,
      siPlain,
      quantity: unloadQty,
      performedBy,
    });
    slotRestore = restoreResult?.restored ?? 0;
  } catch (slotErr) {
    console.warn(
      "[secondaryVehicleUnload] slot restore:",
      slotErr?.message || slotErr
    );
  }

  await recordSecondaryUnloadOnLedger(session, {
    dispatchBatchId: batchId,
    plantOutwardId: plantOutward._id,
    secondaryInwardId: sourceInwardId,
    secondaryOutwardId,
    quantity: unloadQty,
    performedBy,
    metadata: {
      dispatchId: linkedDispatchDoc._id,
      slotRestore,
    },
  });

  await recordShedActivity({
    batchId,
    stage: "secondary_inward",
    subdocId: sourceInwardId,
    action: SHED_ACTIVITY_ACTIONS.SECONDARY_OUTWARD,
    activityName: `अनलोड · ${unloadQty} रोप परत`,
    performedBy,
    quantity: unloadQty,
    metadata: {
      secondaryOutwardId,
      linkedDispatchId: linkedDispatchDoc._id,
      slotRestore,
      unload: true,
    },
    session,
  });

  return {
    batchId,
    secondaryOutwardId,
    secondaryInwardId: String(sourceInwardId),
    plants: unloadQty,
    trays: traysReturned,
    slotRestore,
    linkedOrderId: outward.linkedOrderId ? String(outward.linkedOrderId) : null,
    fullyRemoved: fullUnload,
  };
}

export async function reduceDispatchOrderShedLoaded({
  session,
  dispatchDoc,
  orderId,
  plantsUnloaded,
}) {
  if (!orderId || plantsUnloaded < 1) return null;
  const oid = String(orderId);
  const details = dispatchDoc.orderDispatchDetails || [];
  const idx = details.findIndex((d) => String(d.orderId) === oid);
  if (idx < 0) return null;

  const row = details[idx];
  const prev = Math.max(0, Number(row.shedLoadedQuantity) || 0);
  const next = Math.max(0, prev - plantsUnloaded);
  const dispatchQty = Math.max(0, Number(row.dispatchQuantity) || 0);

  dispatchDoc.orderDispatchDetails[idx].shedLoadedQuantity = next;
  if (next < 1) {
    dispatchDoc.orderDispatchDetails[idx].shedLoadedFromSecondary = false;
  }

  await dispatchDoc.save({ session, validateBeforeSave: true });

  return {
    orderId: oid,
    shedLoadedQuantity: next,
    dispatchQuantity: dispatchQty,
    fullyLoaded: dispatchQty > 0 && next >= dispatchQty,
  };
}

const orderRemainingPlantsValue = (doc) => {
  const rem = doc?.remainingPlants;
  if (rem != null && Number.isFinite(Number(rem))) return Number(rem);
  return Number(doc?.numberOfPlants || 0) + Number(doc?.additionalPlants || 0);
};

async function revertOrderAfterUnload({
  session,
  orderId,
  plantsUnloaded,
  linkedDispatchDoc,
  performedBy,
}) {
  if (!orderId || plantsUnloaded < 1) return null;

  const orderDoc = await Order.findById(orderId).session(session);
  if (!orderDoc) return null;

  const currentRemaining = orderRemainingPlantsValue(orderDoc);
  const newRemaining = currentRemaining + plantsUnloaded;
  let newStatus = orderDoc.orderStatus;

  if (orderDoc.orderStatus === "DISPATCHED") {
    newStatus = "DISPATCH_PROCESS";
  } else if (
    orderDoc.orderStatus === "DISPATCH_PROCESS" ||
    orderDoc.orderStatus === "READY_FOR_DISPATCH"
  ) {
    newStatus = "DISPATCH_PROCESS";
  }

  await updateOrderWithLedgerSync({
    orderId,
    existingDoc: orderDoc,
    session,
    userId: performedBy,
    contextLabel: "secondary_vehicle_unload",
    updateOperation: {
      $set: {
        remainingPlants: newRemaining,
        orderStatus: newStatus,
      },
      $push: {
        dispatchHistory: {
          date: new Date(),
          quantity: -plantsUnloaded,
          remainingAfterDispatch: newRemaining,
          processedBy:
            performedBy && mongoose.isValidObjectId(String(performedBy))
              ? performedBy
              : undefined,
          driverName: linkedDispatchDoc?.driverName || "",
          vehicleName: linkedDispatchDoc?.vehicleName || "",
          dispatchId: linkedDispatchDoc._id,
          source: "SECONDARY_SHED_UNLOAD",
          remarks: "Plants returned to secondary shed from vehicle",
        },
      },
    },
  });

  return { orderId: String(orderId), remainingPlants: newRemaining, orderStatus: newStatus };
}

export async function executeSecondaryVehicleUnload({
  dispatchId,
  linkedOrderId,
  outwardSelections,
  plantRowIndex = 0,
  performedBy,
}) {
  const dispatchDoc = await findDispatchActiveByIdOrTransport(dispatchId);
  assertDispatchShedOpsAllowed(dispatchDoc);

  const selections = normalizeOutwardUnloadSelections(outwardSelections);
  if (!selections.length) {
    throw new AppError("At least one outward line with plants is required", 400);
  }

  if (linkedOrderId) {
    const onVehicle = unionDispatchOrderObjectIds(dispatchDoc).some(
      (oid) => String(oid) === String(linkedOrderId)
    );
    if (!onVehicle) {
      throw new AppError("linkedOrderId must be on the linked vehicle dispatch", 400);
    }
  }

  const { lines: loadedLines } = await collectLoadedOutwardLinesForDispatch(
    dispatchDoc._id,
    linkedOrderId || undefined
  );
  const lineByOutwardId = new Map(
    loadedLines.map((l) => [l.secondaryOutwardId, l])
  );

  for (const sel of selections) {
    const line = lineByOutwardId.get(sel.secondaryOutwardId);
    if (!line) {
      throw new AppError(`Outward line ${sel.secondaryOutwardId} not on this vehicle`, 400);
    }
    if (sel.plants > line.plants) {
      throw new AppError(
        `Cannot unload ${sel.plants} from line — only ${line.plants} loaded`,
        400
      );
    }
    if (!sel.batchId) sel.batchId = line.batchId;
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const freshDispatch = await Dispatch.findById(dispatchDoc._id).session(session);
    if (!freshDispatch) throw new AppError("Vehicle dispatch not found", 404);

    const results = [];
    let totalUnloaded = 0;
    let slotRestoreTotal = 0;
    const orderIdsTouched = new Set();

    for (const sel of selections) {
      const lineResult = await executeOneSecondaryUnloadLine({
        session,
        batchId: sel.batchId,
        secondaryOutwardId: sel.secondaryOutwardId,
        plantsToUnload: sel.plants,
        linkedDispatchDoc: freshDispatch,
        performedBy,
      });
      results.push(lineResult);
      totalUnloaded += lineResult.plants;
      slotRestoreTotal += lineResult.slotRestore || 0;
      if (lineResult.linkedOrderId) orderIdsTouched.add(lineResult.linkedOrderId);
    }

    const resolvedOrderId =
      linkedOrderId || (orderIdsTouched.size === 1 ? [...orderIdsTouched][0] : null);

    let orderUnloaded = null;
    if (resolvedOrderId) {
      orderUnloaded = await reduceDispatchOrderShedLoaded({
        session,
        dispatchDoc: freshDispatch,
        orderId: resolvedOrderId,
        plantsUnloaded: totalUnloaded,
      });
      await revertOrderAfterUnload({
        session,
        orderId: resolvedOrderId,
        plantsUnloaded: totalUnloaded,
        linkedDispatchDoc: freshDispatch,
        performedBy,
      });
    }

    const newStatus = await syncDispatchTransportStatusAfterShedChange({
      session,
      dispatchDoc: freshDispatch,
      plantRowIndex,
    });

    await session.commitTransaction();

    return {
      allocations: results,
      totalUnloaded,
      slotRestoreTotal,
      orderUnloaded,
      linkedOrderId: resolvedOrderId,
      transportStatus: newStatus,
    };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}
