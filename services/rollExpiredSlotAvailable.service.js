/**
 * Roll booking capacity (and optional actualPlants) from expired slots onto today's slot.
 */

import mongoose from "mongoose";
import moment from "moment";
import PlantSlot from "../models/slots.model.js";
import PlantCms from "../models/plantCms.model.js";
import SlotTransferLog from "../models/slotTransfer.model.js";
import SlotReadyRollLog from "../models/slotReadyRollLog.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import { computeOverdueDays } from "./calendarReadySlotRelocate.service.js";
import { secondaryInwardCalendarReady } from "./secondaryShedSlotStock.service.js";
import { resolveSlotBufferFields } from "../utility/bufferUtils.js";
import { SLOT_TRAIL_ACTIONS } from "../constants/slotTrailActions.js";
import {
  appendTransferSlotTrail,
  buildSlotSnapshot,
} from "../utility/slotTransferTrail.js";
import {
  isSlotContainingDate,
  isSlotExpiredByEndDay,
} from "./pastDueSlotRollover.service.js";

const safeArray = (value) => (Array.isArray(value) ? value : []);

async function findSlotDetails(slotId) {
  if (!mongoose.Types.ObjectId.isValid(slotId)) return null;

  const slotObjectId = new mongoose.Types.ObjectId(slotId);
  const plantSlotDoc = await PlantSlot.findOne({
    "subtypeSlots.slots._id": slotObjectId,
  }).lean();

  if (!plantSlotDoc) return null;

  for (const subtype of plantSlotDoc.subtypeSlots || []) {
    const slot = (subtype.slots || []).find(
      (item) => item._id?.toString() === slotObjectId.toString()
    );
    if (slot) {
      return {
        plantSlotId: plantSlotDoc._id,
        plantId: plantSlotDoc.plantId,
        plantSlotYear: plantSlotDoc.year,
        subtypeId: subtype.subtypeId,
        slot,
      };
    }
  }
  return null;
}

function getSlotEffectiveAvailablePlants(slot) {
  return resolveSlotBufferFields(slot).availablePlants;
}

function slotLabel(slot) {
  return `${slot?.startDay || ""} – ${slot?.endDay || ""}`;
}

async function listSubtypeSlots(plantId, subtypeId, year) {
  const query = {
    plantId: new mongoose.Types.ObjectId(plantId),
    year: Number(year),
    "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtypeId),
  };
  const doc = await PlantSlot.findOne(query).lean();
  if (!doc) return [];

  const subtypeSlot = (doc.subtypeSlots || []).find(
    (s) => s.subtypeId?.toString() === String(subtypeId)
  );
  return subtypeSlot?.slots || [];
}

export async function listRollExpiredAvailableSources(targetSlotId, asOfDate = new Date()) {
  const targetDetails = await findSlotDetails(targetSlotId);
  if (!targetDetails) {
    throw new Error("Target slot not found");
  }

  if (!isSlotContainingDate(targetDetails.slot, asOfDate)) {
    throw new Error("Roll expired available is only allowed on today's slot window");
  }

  const slots = await listSubtypeSlots(
    targetDetails.plantId,
    targetDetails.subtypeId,
    targetDetails.plantSlotYear
  );

  const sources = [];
  for (const slot of slots) {
    const slotId = slot._id?.toString?.() || String(slot._id);
    if (slotId === String(targetSlotId)) continue;
    if (!isSlotExpiredByEndDay(slot, asOfDate)) continue;

    const availablePlants = getSlotEffectiveAvailablePlants(slot);
    const actualPlants = Number(slot.actualPlants) || 0;
    const actualReadyPlants = Number(slot.actualReadyPlants) || 0;
    if (availablePlants <= 0 && actualPlants <= 0 && actualReadyPlants <= 0) continue;

    sources.push({
      slotId,
      startDay: slot.startDay,
      endDay: slot.endDay,
      month: slot.month,
      label: slotLabel(slot),
      availablePlants,
      actualPlants,
      actualReadyPlants,
      totalPlants: Number(slot.totalPlants) || 0,
      isExpired: true,
    });
  }

  sources.sort((a, b) =>
    moment(a.startDay, "DD-MM-YYYY").valueOf() - moment(b.startDay, "DD-MM-YYYY").valueOf()
  );

  const targetAvailable = getSlotEffectiveAvailablePlants(targetDetails.slot);

  return {
    target: {
      slotId: String(targetSlotId),
      label: slotLabel(targetDetails.slot),
      availablePlants: targetAvailable,
      actualPlants: Number(targetDetails.slot.actualPlants) || 0,
      actualReadyPlants: Number(targetDetails.slot.actualReadyPlants) || 0,
      rolledInAvailablePlants: Number(targetDetails.slot.rolledInAvailablePlants) || 0,
      rolledInActualReadyPlants: Number(targetDetails.slot.rolledInActualReadyPlants) || 0,
    },
    sources,
  };
}

async function applyCapacityTransfer({
  sourceDetails,
  targetDetails,
  sourceSlotId,
  targetSlotId,
  qty,
  reason,
  performedBy,
  session,
  transferKind,
}) {
  const sourceTotal = Number(sourceDetails.slot.totalPlants) || 0;
  const sourceAvailable = getSlotEffectiveAvailablePlants(sourceDetails.slot);
  const sourceBooked = Number(sourceDetails.slot.totalBookedPlants) || 0;
  const sourceBuffer = Number(sourceDetails.slot.effectiveBuffer || sourceDetails.slot.buffer) || 0;
  const sourceBufferAmount = Number(sourceDetails.slot.bufferAmount) || 0;

  if (qty > sourceAvailable) {
    throw new Error(`Source slot max available is ${sourceAvailable}`);
  }

  const targetTotal = Number(targetDetails.slot.totalPlants) || 0;
  const targetBooked = Number(targetDetails.slot.totalBookedPlants) || 0;
  const targetBufferAmount = Number(targetDetails.slot.bufferAmount) || 0;

  const newSourceTotal = sourceTotal - qty;
  const newSourceAvailable = Math.max(0, newSourceTotal - sourceBooked - sourceBufferAmount);
  const newTargetTotal = targetTotal + qty;
  const newTargetAvailable = Math.max(0, newTargetTotal - targetBooked - targetBufferAmount);

  const sourceSubtypeOid = new mongoose.Types.ObjectId(sourceDetails.subtypeId.toString());
  const targetSubtypeOid = new mongoose.Types.ObjectId(targetDetails.subtypeId.toString());
  const sourceSlotOid = new mongoose.Types.ObjectId(sourceSlotId);
  const targetSlotOid = new mongoose.Types.ObjectId(targetSlotId);

  await PlantSlot.updateOne(
    { _id: sourceDetails.plantSlotId },
    {
      $set: {
        "subtypeSlots.$[st].slots.$[sl].totalPlants": newSourceTotal,
        "subtypeSlots.$[st].slots.$[sl].availablePlants": newSourceAvailable,
      },
    },
    {
      arrayFilters: [{ "st.subtypeId": sourceSubtypeOid }, { "sl._id": sourceSlotOid }],
      session,
    }
  );

  await PlantSlot.updateOne(
    { _id: targetDetails.plantSlotId },
    {
      $set: {
        "subtypeSlots.$[st].slots.$[sl].totalPlants": newTargetTotal,
        "subtypeSlots.$[st].slots.$[sl].availablePlants": newTargetAvailable,
      },
      $inc: {
        "subtypeSlots.$[st].slots.$[sl].rolledInAvailablePlants": qty,
      },
    },
    {
      arrayFilters: [{ "st.subtypeId": targetSubtypeOid }, { "sl._id": targetSlotOid }],
      session,
    }
  );

  const sourceBeforeCap = buildSlotSnapshot({
    ...sourceDetails.slot,
    totalPlants: sourceTotal,
    availablePlants: sourceAvailable,
  });
  const sourceAfterCap = buildSlotSnapshot({
    ...sourceDetails.slot,
    totalPlants: newSourceTotal,
    availablePlants: newSourceAvailable,
  });
  const targetBeforeCap = buildSlotSnapshot({
    ...targetDetails.slot,
    totalPlants: targetTotal,
    availablePlants: Number(targetDetails.slot.availablePlants) ?? 0,
  });
  const targetAfterCap = buildSlotSnapshot({
    ...targetDetails.slot,
    totalPlants: newTargetTotal,
    availablePlants: newTargetAvailable,
    rolledInAvailablePlants:
      (Number(targetDetails.slot.rolledInAvailablePlants) || 0) + qty,
  });

  const metaBase = {
    transferKind,
    peerSlotId: null,
    sourceSlotLabel: slotLabel(sourceDetails.slot),
    targetSlotLabel: slotLabel(targetDetails.slot),
  };

  await appendTransferSlotTrail({
    slotId: sourceSlotId,
    action: SLOT_TRAIL_ACTIONS.CAPACITY_TRANSFER_OUT,
    quantity: qty,
    performedBy,
    notes: reason || "Expired slot available rolled out",
    reason: `Capacity rolled to ${slotLabel(targetDetails.slot)}`,
    metadata: { ...metaBase, transferType: "capacity", peerSlotId: targetSlotId },
    before: sourceBeforeCap,
    after: sourceAfterCap,
    bufferPercentage: sourceBuffer,
    bufferAmount: sourceBufferAmount,
    session,
  });

  await appendTransferSlotTrail({
    slotId: targetSlotId,
    action: SLOT_TRAIL_ACTIONS.CAPACITY_TRANSFER_IN,
    quantity: qty,
    performedBy,
    notes: reason || "Expired slot available rolled in",
    reason: `Capacity rolled from ${slotLabel(sourceDetails.slot)}`,
    metadata: { ...metaBase, transferType: "capacity", peerSlotId: sourceSlotId },
    before: targetBeforeCap,
    after: targetAfterCap,
    bufferPercentage: Number(targetDetails.slot.effectiveBuffer || targetDetails.slot.buffer) || 0,
    bufferAmount: targetBufferAmount,
    session,
  });

  sourceDetails.slot.totalPlants = newSourceTotal;
  sourceDetails.slot.availablePlants = newSourceAvailable;
  targetDetails.slot.totalPlants = newTargetTotal;
  targetDetails.slot.availablePlants = newTargetAvailable;
  targetDetails.slot.rolledInAvailablePlants =
    (Number(targetDetails.slot.rolledInAvailablePlants) || 0) + qty;

  return { availableQty: qty };
}

async function applyActualTransfer({
  sourceDetails,
  targetDetails,
  sourceSlotId,
  targetSlotId,
  actualQty,
  reason,
  performedBy,
  session,
  transferKind,
}) {
  if (actualQty <= 0) return { actualQty: 0 };

  const sourceActual = Number(sourceDetails.slot.actualPlants) || 0;
  const targetActual = Number(targetDetails.slot.actualPlants) || 0;

  if (actualQty > sourceActual) {
    throw new Error(`Source slot max actualPlants is ${sourceActual}`);
  }

  const newSourceActual = sourceActual - actualQty;
  const newTargetActual = targetActual + actualQty;

  const sourceSubtypeOid = new mongoose.Types.ObjectId(sourceDetails.subtypeId.toString());
  const targetSubtypeOid = new mongoose.Types.ObjectId(targetDetails.subtypeId.toString());
  const sourceSlotOid = new mongoose.Types.ObjectId(sourceSlotId);
  const targetSlotOid = new mongoose.Types.ObjectId(targetSlotId);

  await PlantSlot.updateOne(
    { _id: sourceDetails.plantSlotId },
    {
      $set: {
        "subtypeSlots.$[st].slots.$[sl].actualPlants": newSourceActual,
      },
    },
    {
      arrayFilters: [{ "st.subtypeId": sourceSubtypeOid }, { "sl._id": sourceSlotOid }],
      session,
    }
  );

  await PlantSlot.updateOne(
    { _id: targetDetails.plantSlotId },
    {
      $set: {
        "subtypeSlots.$[st].slots.$[sl].actualPlants": newTargetActual,
      },
    },
    {
      arrayFilters: [{ "st.subtypeId": targetSubtypeOid }, { "sl._id": targetSlotOid }],
      session,
    }
  );

  const sourceBefore = buildSlotSnapshot({ ...sourceDetails.slot, actualPlants: sourceActual });
  const sourceAfter = buildSlotSnapshot({ ...sourceDetails.slot, actualPlants: newSourceActual });
  const targetBefore = buildSlotSnapshot({ ...targetDetails.slot, actualPlants: targetActual });
  const targetAfter = buildSlotSnapshot({ ...targetDetails.slot, actualPlants: newTargetActual });

  const meta = { transferKind, peerSlotId: null };

  await appendTransferSlotTrail({
    slotId: sourceSlotId,
    action: SLOT_TRAIL_ACTIONS.EXPIRED_ACTUAL_ROLL_OUT,
    quantity: actualQty,
    performedBy,
    notes: reason || "Expired slot actual plants rolled out",
    reason: `Actual plants rolled to ${slotLabel(targetDetails.slot)}`,
    metadata: { ...meta, peerSlotId: targetSlotId },
    before: sourceBefore,
    after: sourceAfter,
    session,
  });

  await appendTransferSlotTrail({
    slotId: targetSlotId,
    action: SLOT_TRAIL_ACTIONS.EXPIRED_ACTUAL_ROLL_IN,
    quantity: actualQty,
    performedBy,
    notes: reason || "Expired slot actual plants rolled in",
    reason: `Actual plants rolled from ${slotLabel(sourceDetails.slot)}`,
    metadata: { ...meta, peerSlotId: sourceSlotId },
    before: targetBefore,
    after: targetAfter,
    session,
  });

  sourceDetails.slot.actualPlants = newSourceActual;
  targetDetails.slot.actualPlants = newTargetActual;

  return { actualQty };
}

async function applyReadyTransfer({
  sourceDetails,
  targetDetails,
  sourceSlotId,
  targetSlotId,
  readyQty,
  reason,
  performedBy,
  session,
  transferKind,
  rollKind = "expired_manual",
}) {
  if (readyQty <= 0) return { readyQty: 0 };

  const sourceReady = Number(sourceDetails.slot.actualReadyPlants) || 0;
  const targetReady = Number(targetDetails.slot.actualReadyPlants) || 0;

  if (readyQty > sourceReady) {
    throw new Error(`Source slot max actualReadyPlants is ${sourceReady}`);
  }

  const newSourceReady = sourceReady - readyQty;
  const newTargetReady = targetReady + readyQty;

  const sourceSubtypeOid = new mongoose.Types.ObjectId(sourceDetails.subtypeId.toString());
  const targetSubtypeOid = new mongoose.Types.ObjectId(targetDetails.subtypeId.toString());
  const sourceSlotOid = new mongoose.Types.ObjectId(sourceSlotId);
  const targetSlotOid = new mongoose.Types.ObjectId(targetSlotId);

  await PlantSlot.updateOne(
    { _id: sourceDetails.plantSlotId },
    {
      $set: {
        "subtypeSlots.$[st].slots.$[sl].actualReadyPlants": newSourceReady,
      },
    },
    {
      arrayFilters: [{ "st.subtypeId": sourceSubtypeOid }, { "sl._id": sourceSlotOid }],
      session,
    }
  );

  await PlantSlot.updateOne(
    { _id: targetDetails.plantSlotId },
    {
      $set: {
        "subtypeSlots.$[st].slots.$[sl].actualReadyPlants": newTargetReady,
      },
      $inc: {
        "subtypeSlots.$[st].slots.$[sl].rolledInActualReadyPlants": readyQty,
      },
    },
    {
      arrayFilters: [{ "st.subtypeId": targetSubtypeOid }, { "sl._id": targetSlotOid }],
      session,
    }
  );

  const sourceBefore = buildSlotSnapshot({
    ...sourceDetails.slot,
    actualReadyPlants: sourceReady,
  });
  const sourceAfter = buildSlotSnapshot({
    ...sourceDetails.slot,
    actualReadyPlants: newSourceReady,
  });
  const targetBefore = buildSlotSnapshot({
    ...targetDetails.slot,
    actualReadyPlants: targetReady,
  });
  const targetAfter = buildSlotSnapshot({
    ...targetDetails.slot,
    actualReadyPlants: newTargetReady,
    rolledInActualReadyPlants:
      (Number(targetDetails.slot.rolledInActualReadyPlants) || 0) + readyQty,
  });

  const meta = { transferKind, peerSlotId: null, rollKind };

  await appendTransferSlotTrail({
    slotId: sourceSlotId,
    action: SLOT_TRAIL_ACTIONS.EXPIRED_READY_ROLL_OUT,
    quantity: readyQty,
    performedBy,
    notes: reason || "Expired slot ready plants rolled out",
    reason: `Ready plants rolled to ${slotLabel(targetDetails.slot)}`,
    metadata: { ...meta, peerSlotId: targetSlotId },
    before: sourceBefore,
    after: sourceAfter,
    session,
  });

  await appendTransferSlotTrail({
    slotId: targetSlotId,
    action: SLOT_TRAIL_ACTIONS.EXPIRED_READY_ROLL_IN,
    quantity: readyQty,
    performedBy,
    notes: reason || "Expired slot ready plants rolled in",
    reason: `Ready plants rolled from ${slotLabel(sourceDetails.slot)}`,
    metadata: { ...meta, peerSlotId: sourceSlotId },
    before: targetBefore,
    after: targetAfter,
    session,
  });

  sourceDetails.slot.actualReadyPlants = newSourceReady;
  targetDetails.slot.actualReadyPlants = newTargetReady;
  targetDetails.slot.rolledInActualReadyPlants =
    (Number(targetDetails.slot.rolledInActualReadyPlants) || 0) + readyQty;

  await recordReadyRollLogsForTransfer({
    sourceSlotId,
    targetSlotId,
    sourceDetails,
    targetDetails,
    readyQty,
    reason,
    performedBy,
    rollKind,
    session,
  });

  return { readyQty };
}

async function recordReadyRollLogsForTransfer({
  sourceSlotId,
  targetSlotId,
  sourceDetails,
  targetDetails,
  readyQty,
  reason,
  performedBy,
  rollKind,
  session,
}) {
  const asOf = new Date();
  const pos = await PlantOutward.find({
    "secondaryInward.linkedBookingSlotId": new mongoose.Types.ObjectId(sourceSlotId),
  })
    .populate({ path: "batchId", select: "batchNumber plantCmsId plantSubtypeId secondaryPlantReadyDays" })
    .session(session)
    .lean();

  const lines = [];
  for (const po of pos) {
    const batchLean = po.batchId && typeof po.batchId === "object" ? po.batchId : null;
    const batchId = batchLean?._id ?? po.batchId;
    for (const si of po.secondaryInward || []) {
      if (String(si.linkedBookingSlotId) !== String(sourceSlotId)) continue;
      if (!secondaryInwardCalendarReady(si, batchLean, moment(asOf).startOf("day"))) continue;
      const synced = Math.max(0, Number(si.slotStockSyncedPlants) || 0);
      if (synced < 1) continue;
      lines.push({
        batchId,
        batchNumber: batchLean?.batchNumber ?? "",
        secondaryInwardId: si._id,
        plantOutwardId: po._id,
        pollyhouse: si.pollyhouse ?? "",
        quantityReady: synced,
        expectedReadyDate: si.expectedReadyDate ?? null,
      });
    }
  }

  let remaining = readyQty;
  const docs = [];
  for (const ln of lines) {
    if (remaining < 1) break;
    const qty = Math.min(ln.quantityReady, remaining);
    remaining -= qty;
    docs.push({
      sourceSlotId: new mongoose.Types.ObjectId(sourceSlotId),
      targetSlotId: new mongoose.Types.ObjectId(targetSlotId),
      plantId: targetDetails.plantId,
      subtypeId: targetDetails.subtypeId,
      batchId: ln.batchId,
      secondaryInwardId: ln.secondaryInwardId,
      plantOutwardId: ln.plantOutwardId,
      batchNumber: ln.batchNumber,
      pollyhouse: ln.pollyhouse,
      quantityReady: qty,
      expectedReadyDate: ln.expectedReadyDate,
      overdueDays: computeOverdueDays(ln.expectedReadyDate, asOf),
      rollKind,
      sourceSlotLabel: slotLabel(sourceDetails.slot),
      targetSlotLabel: slotLabel(targetDetails.slot),
      reason: reason || "",
      performedBy,
    });
  }

  if (docs.length) {
    await SlotReadyRollLog.create(docs, { session });
  }
}

export async function listReadyRollLogForSlot(targetSlotId, { limit = 100 } = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(targetSlotId))) return [];
  const rows = await SlotReadyRollLog.find({
    targetSlotId: new mongoose.Types.ObjectId(targetSlotId),
  })
    .sort({ createdAt: -1 })
    .limit(Math.min(500, Math.max(1, Number(limit) || 100)))
    .lean();
  return rows;
}

export async function summarizeReadyRollForSlot(targetSlotId) {
  if (!mongoose.Types.ObjectId.isValid(String(targetSlotId))) {
    return { totalRolledReady: 0, overdueLines: 0, latestRollAt: null };
  }
  const oid = new mongoose.Types.ObjectId(targetSlotId);
  const agg = await SlotReadyRollLog.aggregate([
    { $match: { targetSlotId: oid } },
    {
      $group: {
        _id: null,
        totalRolledReady: { $sum: "$quantityReady" },
        overdueLines: {
          $sum: { $cond: [{ $gt: ["$overdueDays", 0] }, 1, 0] },
        },
        latestRollAt: { $max: "$createdAt" },
      },
    },
  ]);
  const row = agg[0] || {};
  return {
    totalRolledReady: Number(row.totalRolledReady) || 0,
    overdueLines: Number(row.overdueLines) || 0,
    latestRollAt: row.latestRollAt ?? null,
  };
}

export async function runExpiredReadyRollAuto({ asOfDate = new Date() } = {}) {
  const plantSlots = await PlantSlot.find({}).lean();
  let rolled = 0;
  let errors = 0;

  for (const doc of plantSlots) {
    for (const st of doc.subtypeSlots || []) {
      for (const slot of st.slots || []) {
        if (!isSlotExpiredByEndDay(slot, asOfDate)) continue;
        const ready = Number(slot.actualReadyPlants) || 0;
        if (ready < 1) continue;

        const targetId = findCurrentSlotIdForExpiredRoll(
          st.slots || [],
          asOfDate
        );
        if (!targetId || targetId === String(slot._id)) continue;

        try {
          await runRollExpiredSlotAvailable({
            targetSlotId: targetId,
            transfers: [
              {
                sourceSlotId: String(slot._id),
                availableQty: 0,
                readyQty: ready,
              },
            ],
            reason: "Auto expired ready roll",
            performedBy: null,
            asOfDate,
            rollKind: "expired_auto",
          });
          rolled += 1;
        } catch (err) {
          errors += 1;
          console.warn("[ExpiredReadyRoll] auto", slot._id, err?.message || err);
        }
      }
    }
  }

  return { slotsRolled: rolled, errors, asOf: moment(asOfDate).format("YYYY-MM-DD") };
}

function findCurrentSlotIdForExpiredRoll(slots, asOfDate) {
  for (const slot of slots || []) {
    if (isSlotContainingDate(slot, asOfDate)) {
      return slot._id?.toString?.() || String(slot._id);
    }
  }
  for (const slot of slots || []) {
    if (!isSlotExpiredByEndDay(slot, asOfDate)) {
      return slot._id?.toString?.() || String(slot._id);
    }
  }
  return null;
}

export async function runRollExpiredSlotAvailable({
  targetSlotId,
  transfers,
  reason = "",
  performedBy = null,
  asOfDate = new Date(),
  rollKind = "expired_manual",
}) {
  if (!targetSlotId || !Array.isArray(transfers) || transfers.length === 0) {
    throw new Error("targetSlotId and transfers are required");
  }

  const targetDetails = await findSlotDetails(targetSlotId);
  if (!targetDetails) throw new Error("Target slot not found");
  if (!isSlotContainingDate(targetDetails.slot, asOfDate)) {
    throw new Error("Roll expired available is only allowed on today's slot window");
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  const results = [];
  let totalAvailable = 0;
  let totalReady = 0;

  try {
    const plantInfo = await PlantCms.findById(targetDetails.plantId).select("name subtypes").lean();
    const subtypeNameMap = new Map(
      safeArray(plantInfo?.subtypes).map((s) => [s._id.toString(), s.name])
    );

    for (const row of transfers) {
      const { sourceSlotId, availableQty, actualQty = 0, readyQty = 0 } = row || {};
      const availQty = Math.floor(Number(availableQty) || 0);
      const actQty = Math.floor(Number(actualQty) || 0);
      const rdQty = Math.floor(Number(readyQty) || 0);

      if (!sourceSlotId) throw new Error("Each transfer requires sourceSlotId");
      if (availQty <= 0 && actQty <= 0 && rdQty <= 0) continue;

      const sourceDetails = await findSlotDetails(sourceSlotId);
      if (!sourceDetails) throw new Error(`Source slot not found: ${sourceSlotId}`);

      if (sourceDetails.plantId.toString() !== targetDetails.plantId.toString()) {
        throw new Error("Transfers must be within the same plant");
      }
      if (sourceDetails.subtypeId.toString() !== targetDetails.subtypeId.toString()) {
        throw new Error("Transfers must be within the same subtype");
      }
      if (!isSlotExpiredByEndDay(sourceDetails.slot, asOfDate)) {
        throw new Error(`Source slot is not expired: ${slotLabel(sourceDetails.slot)}`);
      }

      const transferKind = "expired_available_roll";

      if (availQty > 0) {
        await applyCapacityTransfer({
          sourceDetails,
          targetDetails,
          sourceSlotId,
          targetSlotId,
          qty: availQty,
          reason,
          performedBy,
          session,
          transferKind,
        });
        totalAvailable += availQty;
      }

      if (actQty > 0) {
        await applyActualTransfer({
          sourceDetails,
          targetDetails,
          sourceSlotId,
          targetSlotId,
          actualQty: actQty,
          reason,
          performedBy,
          session,
          transferKind,
        });
      }

      if (rdQty > 0) {
        await applyReadyTransfer({
          sourceDetails,
          targetDetails,
          sourceSlotId,
          targetSlotId,
          readyQty: rdQty,
          reason,
          performedBy,
          session,
          transferKind,
          rollKind,
        });
        totalReady += rdQty;
      }

      await SlotTransferLog.create(
        [
          {
            transferType: "expired_available_roll",
            plantId: targetDetails.plantId,
            plantName: plantInfo?.name || "",
            sourceSlotId: new mongoose.Types.ObjectId(sourceSlotId),
            sourceSubtypeId: sourceDetails.subtypeId,
            sourceSubtypeName:
              subtypeNameMap.get(sourceDetails.subtypeId.toString()) || "Subtype",
            targetSlotId: new mongoose.Types.ObjectId(targetSlotId),
            targetSubtypeId: targetDetails.subtypeId,
            targetSubtypeName:
              subtypeNameMap.get(targetDetails.subtypeId.toString()) || "Subtype",
            quantity: availQty,
            reason: `${reason} | readyQty=${rdQty} actualQty=${actQty}`,
            performedBy,
            sourceBefore: {
              availablePlants: getSlotEffectiveAvailablePlants(sourceDetails.slot),
              actualPlants: Number(sourceDetails.slot.actualPlants) || 0,
            },
            targetBefore: {
              availablePlants: getSlotEffectiveAvailablePlants(targetDetails.slot),
              actualPlants: Number(targetDetails.slot.actualPlants) || 0,
            },
          },
        ],
        { session }
      );

      results.push({ sourceSlotId, availableQty: availQty, actualQty: actQty, readyQty: rdQty });
    }

    if (results.length === 0) {
      throw new Error("No valid transfers to apply");
    }

    await session.commitTransaction();

    return {
      targetSlotId: String(targetSlotId),
      transfers: results,
      totalAvailableRolled: totalAvailable,
      totalActualRolled: results.reduce((s, r) => s + (r.actualQty || 0), 0),
      totalReadyRolled: totalReady,
    };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}
