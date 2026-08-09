import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import PlantSlot from "../models/slots.model.js";
import { fmtDDMMYYYY, parseLocalDate } from "./sowingSlotReadyHelpers.js";

function windowDeliveryLabel(order) {
  try {
    return fmtDDMMYYYY(
      parseLocalDate(order.deliveryDate) || new Date(order.deliveryDate)
    );
  } catch {
    return "—";
  }
}

/**
 * Full audit: SowingRequest + sowingBatches on dest + source with slotHistory (sowing dates).
 */
export async function writeTransferAudit({
  order,
  plants,
  transfers,
  destination,
  userId,
  note = "Cover order from slot stock",
}) {
  const qty = Math.max(0, Math.floor(Number(plants) || 0));
  const plant = await PlantCms.findById(order.plantName)
    .select("name subtypes._id subtypes.name")
    .lean();
  const subtype = (plant?.subtypes || []).find(
    (s) => String(s._id) === String(order.plantSubtype)
  );

  const requestNumber = await SowingRequest.generateRequestNumber();
  const now = new Date();
  const destId = destination.slotId;

  const request = new SowingRequest({
    requestNumber,
    plantId: order.plantName,
    plantName: plant?.name || "Plant",
    subtypeId: order.plantSubtype,
    subtypeName: subtype?.name || "Subtype",
    packetsNeeded: 0,
    packetsRequested: 0,
    excessPackets: 0,
    conversionFactor: 1,
    unitName: "packets",
    status: "issued",
    requestedBy: userId,
    issuedBy: userId,
    issuedDate: now,
    notes: `${note} #${order.orderId}`,
    linkedSlotIds: [
      ...new Set([
        String(destId),
        ...transfers.map((t) => String(t.fromSlotId)),
      ]),
    ].map((id) => new mongoose.Types.ObjectId(id)),
    linkedOrderIds: [order._id],
    isExcessiveSowing: false,
    seedSource: "COMPANY",
    packetsFromCompany: 0,
    packetsFromRaising: 0,
    packetsIssued: 0,
    packetsUsed: 0,
    packetsReturned: 0,
    sowedQuantity: qty,
    shedName: "Office",
    completionNotes: `Transferred ${qty} plants → ${destination.label} for order #${order.orderId}`,
    completedBy: userId,
    sowingCompleted: true,
    sowingCompletedDate: now,
    sowingInProgress: false,
    remainingSowingNeeded: 0,
    completionEvents: [
      {
        at: now,
        type: "SOW_COMPLETED",
        by: userId,
        quantity: qty,
        unit: "plants",
        message: `Covered order #${order.orderId} via slot transfer`,
        meta: {
          transferFromExcess: true,
          transfers: transfers.map((t) => ({
            from: t.fromLabel,
            to: t.toLabel,
            plants: t.take,
            offsetDays: t.offsetDays,
          })),
        },
      },
    ],
  });
  await request.save();

  const historyIn = transfers.map((t) => ({
    at: now,
    by: userId || null,
    fromSlotId: t.fromSlotId,
    toSlotId: destId,
    fromReadyDate: t.fromLabel,
    toReadyDate: destination.label,
    plantsSowed: t.take,
    reason: "TRANSFER_FROM_EXCESS",
  }));

  const readyLabel = destination.startDay || windowDeliveryLabel(order);

  await PlantSlot.updateOne(
    { "subtypeSlots.slots._id": destId },
    {
      $push: {
        "subtypeSlots.$[st].slots.$[sl].sowingBatches": {
          sowedAt: now,
          sowingDate: fmtDDMMYYYY(now),
          plantReadyDate: readyLabel,
          plantReadyDays: 0,
          plantsSowed: qty,
          packetsUsed: 0,
          orderCoveredPlants: qty,
          excessPlants: 0,
          shedName: "Office",
          sowingRequestId: request._id,
          requestNumber,
          isExcessiveSowing: false,
          linkedOrderIds: [order._id],
          slotHistory: historyIn,
        },
        "subtypeSlots.$[st].slots.$[sl].linkedSowingRequests": request._id,
      },
    },
    {
      arrayFilters: [{ "st.slots._id": destId }, { "sl._id": destId }],
    }
  );

  for (const t of transfers) {
    if (t.sameSlot || String(t.fromSlotId) === String(destId)) continue;
    const fromId = new mongoose.Types.ObjectId(t.fromSlotId);
    await PlantSlot.updateOne(
      { "subtypeSlots.slots._id": fromId },
      {
        $push: {
          "subtypeSlots.$[st].slots.$[sl].sowingBatches": {
            sowedAt: now,
            sowingDate: fmtDDMMYYYY(now),
            plantsSowed: 0,
            packetsUsed: 0,
            orderCoveredPlants: 0,
            excessPlants: 0,
            shedName: "Office",
            sowingRequestId: request._id,
            requestNumber,
            isExcessiveSowing: false,
            linkedOrderIds: [order._id],
            slotHistory: [
              {
                at: now,
                by: userId || null,
                fromSlotId: fromId,
                toSlotId: destId,
                fromReadyDate: t.fromLabel,
                toReadyDate: destination.label,
                plantsSowed: t.take,
                reason: "TRANSFER_FROM_EXCESS_OUT",
              },
            ],
          },
        },
      },
      {
        arrayFilters: [{ "st.slots._id": fromId }, { "sl._id": fromId }],
      }
    );
  }

  return request;
}

/** Partial transfer: slot batches + history only (no order sow complete). */
export async function writePartialTransferRecord({
  order,
  plants,
  transfers,
  destination,
  userId,
}) {
  const qty = Math.max(0, Math.floor(Number(plants) || 0));
  const now = new Date();
  const destId = destination.slotId;
  const historyIn = transfers.map((t) => ({
    at: now,
    by: userId || null,
    fromSlotId: t.fromSlotId,
    toSlotId: destId,
    fromReadyDate: t.fromLabel,
    toReadyDate: destination.label,
    plantsSowed: t.take,
    reason: "PARTIAL_TRANSFER_FROM_EXCESS",
  }));

  await PlantSlot.updateOne(
    { "subtypeSlots.slots._id": destId },
    {
      $push: {
        "subtypeSlots.$[st].slots.$[sl].sowingBatches": {
          sowedAt: now,
          sowingDate: fmtDDMMYYYY(now),
          plantReadyDate: destination.startDay || "—",
          plantsSowed: qty,
          orderCoveredPlants: qty,
          excessPlants: 0,
          linkedOrderIds: [order._id],
          slotHistory: historyIn,
          completionNotes: `Partial ${qty} for order #${order.orderId}`,
        },
      },
    },
    {
      arrayFilters: [{ "st.slots._id": destId }, { "sl._id": destId }],
    }
  );

  for (const t of transfers) {
    if (t.sameSlot || String(t.fromSlotId) === String(destId)) continue;
    const fromId = new mongoose.Types.ObjectId(t.fromSlotId);
    await PlantSlot.updateOne(
      { "subtypeSlots.slots._id": fromId },
      {
        $push: {
          "subtypeSlots.$[st].slots.$[sl].slotTrail": {
            at: now,
            action: "PARTIAL_TRANSFER_OUT",
            plants: t.take,
            orderId: order.orderId,
            toSlotId: destId,
            toLabel: destination.label,
          },
        },
      },
      {
        arrayFilters: [{ "st.slots._id": fromId }, { "sl._id": fromId }],
      }
    );
  }
}
