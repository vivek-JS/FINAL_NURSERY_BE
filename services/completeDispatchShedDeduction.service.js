import mongoose from "mongoose";
import moment from "moment";
import AppError from "../utility/appError.js";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import { safeMongooseNumber } from "../utility/safeMongooseNumber.js";
import { dispatchDetailForOrder } from "./completeDispatchBatch.service.js";
import { recordSecondaryOutwardOnLedger } from "./secondaryDispatchAvailability.service.js";
import {
  recordShedActivity,
  SHED_ACTIVITY_ACTIONS,
} from "./shedActivity.service.js";
import {
  pollyhouseMatchesFilter,
  computeSecondaryDispatchEligibility,
} from "./secondaryVehicleLoad.service.js";
import {
  syncSecondaryInwardSlotStockAdd,
  subtractSecondaryInwardSlotStock,
} from "./secondaryShedSlotStock.service.js";

function normalizeStr(v) {
  return v != null ? String(v).trim() : "";
}

function buildSecondaryOrderLinkSnapshot(orderDoc, batchLean) {
  let pos = orderDoc.productOrderSnapshot;
  if (pos && typeof pos.toObject === "function") pos = pos.toObject();
  return {
    orderIdNumeric: orderDoc.orderId,
    publicOrderCode: orderDoc.publicOrderCode ?? null,
    batchNumber: batchLean?.batchNumber ?? null,
    plantNameId: orderDoc.plantName,
    plantSubtypeId: orderDoc.plantSubtype,
    productOrderSnapshot: pos || undefined,
    productName: orderDoc.productName,
    productMappingId: orderDoc.productMappingId,
  };
}

/**
 * Plants to remove from lagwad when delivery is completed (this submit).
 */
export function computeCompleteDispatchPlantsToDeduct({
  dispatch,
  order,
  returnsForThisOrder = 0,
  damagedForThisOrder = 0,
} = {}) {
  const detail = dispatchDetailForOrder(dispatch, order?._id ?? order?.id);
  let dispatchQty = Number(detail?.dispatchQuantity);
  if (!Number.isFinite(dispatchQty) || dispatchQty < 1) {
    const total =
      (Number(order?.numberOfPlants) || 0) +
      (Number(order?.additionalPlants) || 0);
    const remaining = Number(order?.remainingPlants) || 0;
    dispatchQty = Math.max(0, total - remaining);
  }
  const ret = Math.max(0, Number(returnsForThisOrder) || 0);
  const dmg = Math.max(0, Number(damagedForThisOrder) || 0);
  return Math.max(0, Math.floor(dispatchQty) - ret - dmg);
}

async function findExistingOutwardForOrderDispatch(session, orderId, dispatchId) {
  const po = await PlantOutward.findOne({
    secondaryOutward: {
      $elemMatch: {
        linkedOrderId: orderId,
        linkedDispatchId: dispatchId,
      },
    },
  })
    .select("secondaryOutward batchId")
    .session(session)
    .lean();
  if (!po?.secondaryOutward?.length) return null;
  const match = po.secondaryOutward.find(
    (row) =>
      String(row.linkedOrderId) === String(orderId) &&
      String(row.linkedDispatchId) === String(dispatchId)
  );
  if (!match?._id) return null;
  return {
    plantOutwardId: po._id,
    batchId: po.batchId,
    secondaryOutwardId: match._id,
    plantsDeducted:
      Number(match.totalQuantity) ||
      Number(match.numberOfPlants) ||
      Number(match.availableQuantity) ||
      0,
  };
}

async function resolveShedLine(session, batchSnapshot) {
  const batchNumber = normalizeStr(batchSnapshot.batchNumber);
  if (!batchNumber) {
    throw new AppError("Batch number is required for shed deduction", 400);
  }

  let batchId = batchSnapshot.batchId;
  let batchDoc = null;
  if (batchId && mongoose.isValidObjectId(String(batchId))) {
    batchDoc = await DispatchBatch.findById(batchId).session(session).lean();
  }
  if (!batchDoc) {
    batchDoc = await DispatchBatch.findOne({ batchNumber }).session(session).lean();
    batchId = batchDoc?._id;
  }
  if (!batchDoc?._id) {
    throw new AppError(`Batch not found: ${batchNumber}`, 404);
  }

  const plantOutward = await PlantOutward.findOne({ batchId: batchDoc._id }).session(
    session
  );
  if (!plantOutward) {
    throw new AppError("Lagwad record not found for batch", 404);
  }

  const polly = normalizeStr(batchSnapshot.pollyhouse);
  const inwards = plantOutward.secondaryInward || [];
  let secondaryInward = null;

  const snapInwardId = batchSnapshot.secondaryInwardId;
  if (snapInwardId && mongoose.isValidObjectId(String(snapInwardId))) {
    secondaryInward = inwards.find(
      (si) => String(si._id) === String(snapInwardId)
    );
  }
  if (!secondaryInward && polly) {
    secondaryInward = inwards.find((si) =>
      pollyhouseMatchesFilter(si.pollyhouse, polly)
    );
  }
  if (!secondaryInward && inwards.length === 1) {
    secondaryInward = inwards[0];
  }
  if (!secondaryInward?._id) {
    throw new AppError(
      polly
        ? `No lagwad line found for batch ${batchNumber} and shed ${polly}`
        : `No lagwad line found for batch ${batchNumber}`,
      400
    );
  }

  return {
    batchDoc,
    plantOutward,
    batchId: batchDoc._id,
    secondaryInward,
    secondaryInwardId: secondaryInward._id,
  };
}

/**
 * Decrement secondary inward + ledger when office completes delivery from shed stock.
 * Skips vehicle_load (deducted on shed app load) and idempotent re-submits.
 */
export async function applyCompleteDispatchShedDeduction({
  session,
  order,
  dispatch,
  batchSnapshot,
  returnsForThisOrder = 0,
  damagedForThisOrder = 0,
  performedBy,
} = {}) {
  if (!session || !order || !dispatch || !batchSnapshot) {
    throw new AppError("Shed deduction: missing session, order, dispatch, or batch", 500);
  }

  const source = normalizeStr(batchSnapshot.source).toLowerCase();
  if (source === "vehicle_load" || source === "manual") {
    return {
      skipped: true,
      reason: source === "manual" ? "manual" : "vehicle_load",
      batchSnapshot,
    };
  }

  const prevSnap = order.deliveryCompleteBatch;
  if (
    prevSnap?.secondaryOutwardId &&
    mongoose.isValidObjectId(String(prevSnap.secondaryOutwardId))
  ) {
    return {
      skipped: true,
      reason: "already_deducted",
      batchSnapshot: {
        ...batchSnapshot,
        batchId: prevSnap.batchId || batchSnapshot.batchId,
        secondaryInwardId:
          prevSnap.secondaryInwardId || batchSnapshot.secondaryInwardId,
        plantsDeducted: prevSnap.plantsDeducted,
        secondaryOutwardId: prevSnap.secondaryOutwardId,
        deductionAppliedAt: prevSnap.deductionAppliedAt,
      },
    };
  }

  const existingOutward = await findExistingOutwardForOrderDispatch(
    session,
    order._id,
    dispatch._id
  );
  if (existingOutward) {
    const enriched = {
      ...batchSnapshot,
      batchId: existingOutward.batchId || batchSnapshot.batchId,
      plantsDeducted: existingOutward.plantsDeducted,
      secondaryOutwardId: existingOutward.secondaryOutwardId,
      deductionAppliedAt: batchSnapshot.capturedAt || new Date(),
    };
    return { skipped: true, reason: "outward_exists", batchSnapshot: enriched };
  }

  const plantsMoving = computeCompleteDispatchPlantsToDeduct({
    dispatch,
    order,
    returnsForThisOrder,
    damagedForThisOrder,
  });
  if (plantsMoving < 1) {
    return { skipped: true, reason: "zero_qty", batchSnapshot };
  }

  const { batchDoc, plantOutward, batchId, secondaryInward, secondaryInwardId } =
    await resolveShedLine(session, batchSnapshot);

  const avail = Number(secondaryInward.availableQuantity) || 0;
  if (avail < plantsMoving) {
    throw new AppError(
      `Insufficient lagwad stock (${avail} available, ${plantsMoving} required) on batch ${batchDoc.batchNumber}`,
      400
    );
  }

  const siPlain =
    typeof secondaryInward.toObject === "function"
      ? secondaryInward.toObject()
      : { ...secondaryInward };

  const cavity = Math.max(1, Math.floor(Number(siPlain.cavity) || 126));
  const fullTrays = Math.floor(plantsMoving / cavity);
  const partialPlants = plantsMoving % cavity;
  const loadedTrayCount = fullTrays + (partialPlants > 0 ? 1 : 0);
  const resolvedPollyhouse =
    normalizeStr(siPlain.pollyhouse) || normalizeStr(batchSnapshot.pollyhouse);
  const size = siPlain.size;
  const numberOfBottles = Math.max(
    1,
    Math.floor(Number(siPlain.numberOfBottles) || 1)
  );

  const resolvedOutDate = new Date();
  const transferHistory = {
    transferDate: resolvedOutDate,
    quantityTransferred: plantsMoving,
    remarks: `Delivery complete · order #${order.orderId ?? order._id}`,
  };

  const orderLinkSnapshot = buildSecondaryOrderLinkSnapshot(order, batchDoc);

  const secondaryOutwardEntry = {
    secondaryOutwardDate: resolvedOutDate,
    numberOfBottles,
    size,
    cavity,
    numberOfTrays: loadedTrayCount,
    numberOfFullTrays: fullTrays,
    partialTrayPlants: partialPlants,
    totalQuantity: plantsMoving,
    numberOfPlants: plantsMoving,
    availableQuantity: plantsMoving,
    pollyhouse: resolvedPollyhouse,
    laboursEngaged: 1,
    transferStatus: "available",
    sourceSecondaryInwardId: secondaryInwardId,
    linkedOrderId: order._id,
    orderLinkSnapshot,
    linkedDispatchId: dispatch._id,
    dispatchFulfillmentSnapshot: {
      transportId: dispatch.transportId,
      driverName: dispatch.driverName,
      vehicleName: dispatch.vehicleName,
      vehicleNumber: dispatch.vehicleNumber,
    },
    deliveryCompleteDeduction: true,
  };

  const newSecondaryInwardStatus =
    avail - plantsMoving === 0 ? "fully_transferred" : "partially_transferred";

  const updatedDoc = await PlantOutward.findOneAndUpdate(
    { batchId, "secondaryInward._id": secondaryInwardId },
    {
      $push: {
        secondaryOutward: secondaryOutwardEntry,
        "secondaryInward.$.transferHistory": transferHistory,
      },
      $set: {
        "secondaryInward.$.transferStatus": newSecondaryInwardStatus,
        "secondaryInward.$.availableQuantity": avail - plantsMoving,
      },
    },
    { new: true, session, runValidators: true }
  );

  const outArr = updatedDoc?.secondaryOutward || [];
  const newSo = outArr[outArr.length - 1];
  if (!newSo?._id) {
    throw new AppError("Could not resolve new secondary outward id", 500);
  }

  const secondaryDaysForElig =
    Number(safeMongooseNumber(batchDoc.secondaryPlantReadyDays)) || 0;
  const dispatchElig = computeSecondaryDispatchEligibility(
    siPlain,
    secondaryDaysForElig,
    moment().startOf("day")
  );

  let slotSubtract = 0;
  try {
    const syncResult = await syncSecondaryInwardSlotStockAdd({
      session,
      batchId,
      secondaryInwardId,
      batchLean: batchDoc,
      siPlain,
      dispatchEligible: dispatchElig.dispatchEligible,
      force: true,
      readyPositionOnly: true,
      performedBy,
    });
    const siForSubtract = {
      ...siPlain,
      linkedBookingSlotId:
        syncResult?.slotId || siPlain.linkedBookingSlotId || null,
      slotStockSyncedPlants:
        (Number(siPlain.slotStockSyncedPlants) || 0) + (syncResult?.applied ?? 0),
    };
    const subResult = await subtractSecondaryInwardSlotStock({
      session,
      batchId,
      secondaryInwardId,
      batchLean: batchDoc,
      siPlain: siForSubtract,
      quantity: plantsMoving,
      performedBy,
    });
    slotSubtract = subResult?.subtracted ?? 0;
  } catch (slotErr) {
    console.warn(
      "[completeDispatchShedDeduction] slot subtract:",
      slotErr?.message || slotErr
    );
  }

  await recordSecondaryOutwardOnLedger(session, {
    dispatchBatchId: batchId,
    plantOutwardId: updatedDoc._id,
    secondaryInwardId,
    secondaryOutwardId: newSo._id,
    quantity: plantsMoving,
    performedBy,
    metadata: {
      orderId: order._id,
      orderNumber: order.orderId,
      dispatchId: dispatch._id,
      deliveryComplete: true,
    },
  });

  await recordShedActivity({
    batchId,
    stage: "secondary_inward",
    subdocId: secondaryInwardId,
    action: SHED_ACTIVITY_ACTIONS.SECONDARY_OUTWARD,
    activityName: `Delivery complete · order #${order.orderId ?? ""} · ${plantsMoving} plants`,
    performedBy,
    quantity: plantsMoving,
    metadata: {
      secondaryOutwardId: newSo._id,
      linkedDispatchId: dispatch._id,
      linkedOrderId: order._id,
      slotSubtract,
      deliveryComplete: true,
    },
    session,
  });

  const deductionAppliedAt = new Date();
  const enrichedSnapshot = {
    ...batchSnapshot,
    batchId,
    secondaryInwardId,
    pollyhouse: resolvedPollyhouse || batchSnapshot.pollyhouse,
    plantsDeducted: plantsMoving,
    secondaryOutwardId: newSo._id,
    plantOutwardId: updatedDoc._id,
    deductionAppliedAt,
  };

  return {
    skipped: false,
    plantsDeducted: plantsMoving,
    secondaryOutwardId: newSo._id,
    batchSnapshot: enrichedSnapshot,
  };
}
