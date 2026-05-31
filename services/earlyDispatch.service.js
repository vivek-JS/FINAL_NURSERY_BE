import PlantSlot from "../models/slots.model.js";
import AppError from "../utility/appError.js";
import { SLOT_TRAIL_ACTIONS, getSlotTrailActivityName } from "../constants/slotTrailActions.js";
import { getOrderTotalPlants } from "./dealerCommission.service.js";
import {
  findDeliverySlotByDate,
  getSlotWindowById,
  isDateOutsideSlotWindow,
} from "../utility/findDeliverySlot.js";

const PRE_DISPATCH_STATUSES = new Set([
  "PENDING",
  "PROCESSING",
  "ACCEPTED",
  "FARM_READY",
  "ASSIGNED",
]);

const DISPATCH_QUEUE_STATUSES = new Set(["READY_FOR_DISPATCH", "DISPATCH_PROCESS"]);

export function shouldRevertEarlyDispatch(previousStatus, nextStatus, order) {
  if (!order?.dispatchedFromAnotherSlot) return false;
  if (!DISPATCH_QUEUE_STATUSES.has(previousStatus)) return false;
  if (!nextStatus) return false;
  if (["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"].includes(nextStatus)) {
    return true;
  }
  return PRE_DISPATCH_STATUSES.has(nextStatus);
}

export function shouldApplyEarlyDispatch(previousStatus, nextStatus) {
  return nextStatus === "READY_FOR_DISPATCH";
}

export const moveOrderBetweenSlots = async ({
  orderId,
  fromSlotId,
  toSlotId,
  plantsCount,
  session,
  isReadyPlantsOrder,
}) => {
  if (!fromSlotId || !toSlotId || fromSlotId.toString() === toSlotId.toString()) {
    return;
  }

  const slotForUpdate = await PlantSlot.findOne(
    { "subtypeSlots.slots._id": fromSlotId },
    { "subtypeSlots.$": 1 }
  )
    .populate("plantId", "sowingAllowed")
    .session(session);

  const isSowingAllowed = slotForUpdate?.plantId?.sowingAllowed || false;

  const releaseOp = {
    $pull: {
      "subtypeSlots.$[subtypeSlot].slots.$[slot].orders": orderId,
    },
    $inc: {
      "subtypeSlots.$[subtypeSlot].slots.$[slot].totalBookedPlants": -plantsCount,
    },
  };
  if (!isSowingAllowed) {
    releaseOp.$inc["subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants"] =
      plantsCount;
  } else if (isReadyPlantsOrder) {
    releaseOp.$inc["subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants"] =
      -plantsCount;
  }

  await PlantSlot.updateOne({ "subtypeSlots.slots._id": fromSlotId }, releaseOp, {
    arrayFilters: [{ "subtypeSlot.slots._id": fromSlotId }, { "slot._id": fromSlotId }],
    session,
  });

  const bookOp = {
    $push: {
      "subtypeSlots.$[subtypeSlot].slots.$[slot].orders": orderId,
    },
    $inc: {
      "subtypeSlots.$[subtypeSlot].slots.$[slot].totalBookedPlants": plantsCount,
    },
  };
  if (!isSowingAllowed) {
    bookOp.$inc["subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants"] = -plantsCount;
  } else if (isReadyPlantsOrder) {
    bookOp.$inc["subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants"] = plantsCount;
  }

  await PlantSlot.updateOne({ "subtypeSlots.slots._id": toSlotId }, bookOp, {
    arrayFilters: [{ "subtypeSlot.slots._id": toSlotId }, { "slot._id": toSlotId }],
    session,
  });
};

export const appendSlotTrail = async ({
  slotId,
  action,
  quantity,
  orderId,
  performedBy,
  notes,
  session,
}) => {
  const activityName = getSlotTrailActivityName(action);
  const trailEntry = {
    action,
    activityName,
    quantity,
    orderId,
    performedBy: performedBy || null,
    notes: notes || "",
    reason: (typeof notes === "string" && notes.trim()) || activityName,
    previousTotalPlants: 0,
    newTotalPlants: 0,
    previousAvailablePlants: 0,
    newAvailablePlants: 0,
    plus: {},
    minus: {},
    before: {},
    after: {},
  };

  await PlantSlot.updateOne(
    { "subtypeSlots.slots._id": slotId },
    { $push: { "subtypeSlots.$[subtypeSlot].slots.$[slot].slotTrail": trailEntry } },
    {
      arrayFilters: [{ "subtypeSlot.slots._id": slotId }, { "slot._id": slotId }],
      session,
    }
  );
};

const normalizeDispatchDate = (dispatchTargetDate) => {
  const d = new Date(dispatchTargetDate);
  d.setUTCHours(12, 0, 0, 0);
  return d;
};

/**
 * Apply cross-slot transfer when dispatch target is outside current booking slot window.
 * Mutates filteredBody with order fields; sets __earlyDispatchSlotHandled.
 */
export async function applyEarlyDispatch({
  order,
  dispatchTargetDate,
  session,
  filteredBody,
  userId,
}) {
  if (order.quotaSource === "dealer") {
    return;
  }

  const plantCount = getOrderTotalPlants(order);
  if (!plantCount || !order.bookingSlot) {
    return;
  }

  const targetDate = normalizeDispatchDate(dispatchTargetDate);
  const currentSlotWindow = await getSlotWindowById(order.bookingSlot);
  if (!currentSlotWindow) {
    throw new AppError("Current booking slot not found for order", 404);
  }

  if (!isDateOutsideSlotWindow(targetDate, currentSlotWindow)) {
    if (order.dispatchedFromAnotherSlot) {
      await revertEarlyDispatch({ order, session, filteredBody, userId });
    }
    return;
  }

  const plantId = order.plantName?._id || order.plantName;
  const subtypeId = order.plantSubtype?._id || order.plantSubtype;
  if (!plantId || !subtypeId) {
    throw new AppError("Order missing plant or subtype for slot lookup", 400);
  }

  let targetSlot;
  try {
    targetSlot = await findDeliverySlotByDate(plantId, subtypeId, targetDate);
  } catch (err) {
    throw new AppError(
      err.message || "No slot found for dispatch target date",
      400
    );
  }

  const targetSlotId = targetSlot._id;

  if (targetSlotId.toString() === order.bookingSlot.toString()) {
    return;
  }

  const preservedOldDelivery = order.dispatchedFromAnotherSlot
    ? order.oldDeliveryDate
    : order.deliveryDate || null;
  const preservedOriginalSlot = order.dispatchedFromAnotherSlot
    ? order.originalBookingSlot || order.bookingSlot
    : order.bookingSlot;

  const isReadyPlantsOrder = !!(order.productMappingId && order.productName);

  await moveOrderBetweenSlots({
    orderId: order._id,
    fromSlotId: order.bookingSlot,
    toSlotId: targetSlotId,
    plantsCount: plantCount,
    session,
    isReadyPlantsOrder,
  });

  await appendSlotTrail({
    slotId: order.bookingSlot,
    action: SLOT_TRAIL_ACTIONS.EARLY_DISPATCH_OUT,
    quantity: plantCount,
    orderId: order._id,
    performedBy: userId,
    notes: `Cross-slot dispatch to ${targetSlot.startDay}–${targetSlot.endDay}`,
    session,
  });
  await appendSlotTrail({
    slotId: targetSlotId,
    action: SLOT_TRAIL_ACTIONS.EARLY_DISPATCH_IN,
    quantity: plantCount,
    orderId: order._id,
    performedBy: userId,
    notes: `Cross-slot dispatch from ${currentSlotWindow.startDay}–${currentSlotWindow.endDay}`,
    session,
  });

  filteredBody.oldDeliveryDate = preservedOldDelivery;
  filteredBody.originalBookingSlot = preservedOriginalSlot;
  filteredBody.dispatchedFromAnotherSlot = true;
  filteredBody.deliveryDate = targetDate;
  filteredBody.bookingSlot = targetSlotId;
  filteredBody.__earlyDispatchSlotHandled = true;
}

/**
 * Restore original slot and delivery when leaving dispatch queue.
 */
export async function revertEarlyDispatch({
  order,
  session,
  filteredBody,
  userId,
}) {
  if (!order.dispatchedFromAnotherSlot || order.quotaSource === "dealer") {
    return;
  }

  const plantCount = getOrderTotalPlants(order);
  const originalSlotId = order.originalBookingSlot || order.bookingSlot;
  const currentSlotId = order.bookingSlot;

  if (
    originalSlotId &&
    currentSlotId &&
    originalSlotId.toString() !== currentSlotId.toString()
  ) {
    const isReadyPlantsOrder = !!(order.productMappingId && order.productName);

    await moveOrderBetweenSlots({
      orderId: order._id,
      fromSlotId: currentSlotId,
      toSlotId: originalSlotId,
      plantsCount: plantCount,
      session,
      isReadyPlantsOrder,
    });

    await appendSlotTrail({
      slotId: currentSlotId,
      action: SLOT_TRAIL_ACTIONS.EARLY_DISPATCH_REVERT_OUT,
      quantity: plantCount,
      orderId: order._id,
      performedBy: userId,
      session,
    });
    await appendSlotTrail({
      slotId: originalSlotId,
      action: SLOT_TRAIL_ACTIONS.EARLY_DISPATCH_REVERT_IN,
      quantity: plantCount,
      orderId: order._id,
      performedBy: userId,
      session,
    });
  }

  filteredBody.bookingSlot = originalSlotId;
  if (order.oldDeliveryDate) {
    filteredBody.deliveryDate = order.oldDeliveryDate;
  }
  filteredBody.oldDeliveryDate = null;
  filteredBody.originalBookingSlot = null;
  filteredBody.dispatchedFromAnotherSlot = false;
  filteredBody.__earlyDispatchSlotHandled = true;
}

export { PRE_DISPATCH_STATUSES, DISPATCH_QUEUE_STATUSES };
