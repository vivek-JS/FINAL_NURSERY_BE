import mongoose from "mongoose";
import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";
import SlotTransferLog from "../models/slotTransfer.model.js";
import { SLOT_TRAIL_ACTIONS } from "../constants/slotTrailActions.js";
import { moveOrderBetweenSlots } from "./earlyDispatch.service.js";
import {
  appendTransferSlotTrail,
  applyOrderTransferToSlotMemory,
  buildSlotSnapshot,
  findSlotSubdocumentById,
  reconcileSlotAvailablePlants,
} from "../utility/slotTransferTrail.js";

const parseNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Move orders between slots with per-order trail and order history (Slots View mass transfer).
 */
export async function executeMassOrderSlotTransfer({
  sourceSlotId,
  targetSlotId,
  orders,
  sourceDetails,
  targetDetails,
  plantInfo,
  subtypeNameMap,
  reason,
  performedBy,
  session,
}) {
  const sourceSlotObjectId = new mongoose.Types.ObjectId(sourceSlotId);
  const targetSlotObjectId = new mongoose.Types.ObjectId(targetSlotId);
  const sourceWindow = `${sourceDetails.slot.startDay}-${sourceDetails.slot.endDay}`;
  const targetWindow = `${targetDetails.slot.startDay}-${targetDetails.slot.endDay}`;

  const sourceMem = { ...sourceDetails.slot };
  const targetMem = { ...targetDetails.slot };

  for (const order of orders) {
    const orderPlants = parseNum(order.numberOfPlants);
    if (orderPlants <= 0) continue;

    const sourceBefore = buildSlotSnapshot(sourceMem);
    const targetBefore = buildSlotSnapshot(targetMem);

    await moveOrderBetweenSlots({
      orderId: order._id,
      fromSlotId: sourceSlotObjectId,
      toSlotId: targetSlotObjectId,
      fromPlantSlotId: sourceDetails.plantSlotId,
      fromSubtypeId: sourceDetails.subtypeId,
      toPlantSlotId: targetDetails.plantSlotId,
      toSubtypeId: targetDetails.subtypeId,
      plantsCount: orderPlants,
      session,
    });

    applyOrderTransferToSlotMemory(sourceMem, orderPlants, "release");
    applyOrderTransferToSlotMemory(targetMem, orderPlants, "book");

    const sourceAfter = buildSlotSnapshot(sourceMem);
    const targetAfter = buildSlotSnapshot(targetMem);

    const orderLabel = order.orderId ? `#${order.orderId}` : String(order._id);
    const trailNotes =
      reason?.trim() ||
      `Order ${orderLabel}: ${sourceWindow} → ${targetWindow} (${orderPlants} plants)`;

    await appendTransferSlotTrail({
      slotId: sourceSlotId,
      action: SLOT_TRAIL_ACTIONS.ORDER_SLOT_TRANSFER_OUT,
      quantity: orderPlants,
      performedBy,
      notes: trailNotes,
      reason: `Order moved to slot ${targetWindow}`,
      metadata: {
        transferType: "orders",
        peerSlotId: targetSlotId,
        peerSlotWindow: targetWindow,
        orderIds: [order._id],
      },
      before: sourceBefore,
      after: sourceAfter,
      orderId: order._id,
      bufferPercentage: parseNum(sourceDetails.slot.effectiveBuffer || sourceDetails.slot.buffer),
      bufferAmount: parseNum(sourceDetails.slot.bufferAmount),
      session,
    });

    await appendTransferSlotTrail({
      slotId: targetSlotId,
      action: SLOT_TRAIL_ACTIONS.ORDER_SLOT_TRANSFER_IN,
      quantity: orderPlants,
      performedBy,
      notes: trailNotes,
      reason: `Order received from slot ${sourceWindow}`,
      metadata: {
        transferType: "orders",
        peerSlotId: sourceSlotId,
        peerSlotWindow: sourceWindow,
        orderIds: [order._id],
      },
      before: targetBefore,
      after: targetAfter,
      orderId: order._id,
      bufferPercentage: parseNum(targetDetails.slot.effectiveBuffer || targetDetails.slot.buffer),
      bufferAmount: parseNum(targetDetails.slot.bufferAmount),
      session,
    });

    const deliveryChangeEntry = {
      previousDeliveryDate: {
        startDay: sourceDetails.slot.startDay,
        endDay: sourceDetails.slot.endDay,
        month: sourceDetails.slot.month,
        year: sourceDetails.plantSlotYear,
      },
      newDeliveryDate: {
        startDay: targetDetails.slot.startDay,
        endDay: targetDetails.slot.endDay,
        month: targetDetails.slot.month,
        year: targetDetails.plantSlotYear,
      },
      previousSlot: sourceSlotObjectId,
      newSlot: targetSlotObjectId,
      reasonForChange: reason?.trim() || "Mass order transfer from SlotsView",
      changedBy: performedBy,
    };

    const orderEditEntry = {
      field: "bookingSlot",
      previousValue: sourceSlotObjectId,
      newValue: targetSlotObjectId,
      changedBy: performedBy,
      notes: reason?.trim()
        ? `${reason.trim()} — ${sourceWindow} to ${targetWindow}`
        : `Slot transfer: ${sourceWindow} to ${targetWindow}`,
    };

    const orderSet = { bookingSlot: targetSlotObjectId };
    if (!order.dispatchedFromAnotherSlot) {
      orderSet.originalBookingSlot = order.originalBookingSlot || order.bookingSlot || sourceSlotObjectId;
      orderSet.dispatchedFromAnotherSlot = true;
    }

    await Order.updateOne(
      { _id: order._id },
      {
        $set: orderSet,
        $push: {
          deliveryChanges: deliveryChangeEntry,
          orderEditHistory: orderEditEntry,
        },
      },
      { session }
    );
  }

  const totalPlantsToTransfer = orders.reduce(
    (sum, o) => sum + parseNum(o.numberOfPlants),
    0
  );

  const sourceReconciled = await reconcileSlotAvailablePlants(sourceSlotId, session, {
    plantSlotId: sourceDetails.plantSlotId,
    subtypeId: sourceDetails.subtypeId,
  });
  const targetReconciled = await reconcileSlotAvailablePlants(targetSlotId, session, {
    plantSlotId: targetDetails.plantSlotId,
    subtypeId: targetDetails.subtypeId,
  });

  if (sourceReconciled) {
    sourceMem.totalBookedPlants = sourceReconciled.totalBookedPlants;
    sourceMem.availablePlants = sourceReconciled.availablePlants;
  }
  if (targetReconciled) {
    targetMem.totalBookedPlants = targetReconciled.totalBookedPlants;
    targetMem.availablePlants = targetReconciled.availablePlants;
  }

  const sourceAfterFinal = await findSlotSubdocumentById(sourceSlotId, session);
  const targetAfterFinal = await findSlotSubdocumentById(targetSlotId, session);

  await SlotTransferLog.create(
    [
      {
        transferType: "orders",
        orderIds: orders.map((o) => o._id),
        plantId: sourceDetails.plantId,
        plantName: plantInfo?.name || "",
        sourceSlotId: sourceSlotObjectId,
        sourceSubtypeId: sourceDetails.subtypeId,
        sourceSubtypeName: subtypeNameMap.get(sourceDetails.subtypeId.toString()) || "Subtype",
        targetSlotId: targetSlotObjectId,
        targetSubtypeId: targetDetails.subtypeId,
        targetSubtypeName: subtypeNameMap.get(targetDetails.subtypeId.toString()) || "Subtype",
        quantity: totalPlantsToTransfer,
        reason,
        performedBy,
        sourceBefore: {
          primarySowed: parseNum(sourceDetails.slot.primarySowed),
          plantsSowed: parseNum(sourceDetails.slot.plantsSowed),
          officeSowed: parseNum(sourceDetails.slot.officeSowed),
          totalBookedPlants: parseNum(sourceDetails.slot.totalBookedPlants),
          totalPlants: parseNum(sourceDetails.slot.totalPlants),
          availablePlants: parseNum(sourceDetails.slot.availablePlants),
        },
        sourceAfter: sourceAfterFinal
          ? {
              primarySowed: parseNum(sourceAfterFinal.slot.primarySowed),
              plantsSowed: parseNum(sourceAfterFinal.slot.plantsSowed),
              officeSowed: parseNum(sourceAfterFinal.slot.officeSowed),
              totalBookedPlants: parseNum(sourceAfterFinal.slot.totalBookedPlants),
              totalPlants: parseNum(sourceAfterFinal.slot.totalPlants),
              availablePlants: parseNum(sourceAfterFinal.slot.availablePlants),
            }
          : buildSlotSnapshot(sourceMem),
        targetBefore: {
          primarySowed: parseNum(targetDetails.slot.primarySowed),
          plantsSowed: parseNum(targetDetails.slot.plantsSowed),
          officeSowed: parseNum(targetDetails.slot.officeSowed),
          totalBookedPlants: parseNum(targetDetails.slot.totalBookedPlants),
          totalPlants: parseNum(targetDetails.slot.totalPlants),
          availablePlants: parseNum(targetDetails.slot.availablePlants),
        },
        targetAfter: targetAfterFinal
          ? {
              primarySowed: parseNum(targetAfterFinal.slot.primarySowed),
              plantsSowed: parseNum(targetAfterFinal.slot.plantsSowed),
              officeSowed: parseNum(targetAfterFinal.slot.officeSowed),
              totalBookedPlants: parseNum(targetAfterFinal.slot.totalBookedPlants),
              totalPlants: parseNum(targetAfterFinal.slot.totalPlants),
              availablePlants: parseNum(targetAfterFinal.slot.availablePlants),
            }
          : buildSlotSnapshot(targetMem),
        metadata: {
          sourceSlotStartDay: sourceDetails.slot.startDay,
          sourceSlotEndDay: sourceDetails.slot.endDay,
          targetSlotStartDay: targetDetails.slot.startDay,
          targetSlotEndDay: targetDetails.slot.endDay,
          ordersCount: orders.length,
        },
      },
    ],
    { session }
  );

  return {
    ordersCount: orders.length,
    totalPlants: totalPlantsToTransfer,
    source: sourceReconciled
      ? {
          slotId: sourceSlotId,
          availablePlants: sourceReconciled.availablePlants,
          totalBookedPlants: sourceReconciled.totalBookedPlants,
        }
      : null,
    target: targetReconciled
      ? {
          slotId: targetSlotId,
          availablePlants: targetReconciled.availablePlants,
          totalBookedPlants: targetReconciled.totalBookedPlants,
          isOverflow: targetReconciled.isOverflow,
        }
      : null,
  };
}
