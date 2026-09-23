/**
 * Roll **ready lagwad only** from expired slots → current slot.
 * Sow (actualPlants) remains on the expired window as historical/delayed sow record.
 */

import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import { SLOT_TRAIL_ACTIONS } from "../constants/slotTrailActions.js";
import {
  runRollExpiredSlotAvailable,
  listReadyRollLogForSlot,
  summarizeReadyRollForSlot,
} from "./rollExpiredSlotAvailable.service.js";
import {
  findCurrentSlotIdForGroup,
  isSlotExpiredByEndDay,
} from "./pastDueSlotRollover.service.js";
import { buildPendingLagwadBucketsFromSlots } from "../utility/pastDueSlotMetrics.js";

async function loadSubtypeSlots(plantId, subtypeId, year) {
  const doc = await PlantSlot.findOne({
    plantId: new mongoose.Types.ObjectId(String(plantId)),
    year: Number(year),
    "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(String(subtypeId)),
  }).lean();
  if (!doc) return { doc: null, slots: [] };
  const st = (doc.subtypeSlots || []).find(
    (s) => String(s.subtypeId) === String(subtypeId)
  );
  return { doc, slots: st?.slots || [] };
}

export async function rollAllExpiredLagwadForSubtype({
  plantId,
  subtypeId,
  targetSlotId,
  performedBy = null,
  reason = "Roll all pending lagwad from expired windows",
  asOfDate = new Date(),
}) {
  if (!plantId || !subtypeId) {
    throw new Error("plantId and subtypeId are required");
  }

  const year = new Date(asOfDate).getFullYear();
  const { slots } = await loadSubtypeSlots(plantId, subtypeId, year);
  if (!slots.length) {
    throw new Error("No slots found for this plant/subtype/year");
  }

  let resolvedTarget = targetSlotId ? String(targetSlotId) : null;
  if (!resolvedTarget) {
    resolvedTarget = findCurrentSlotIdForGroup(slots, asOfDate);
  }
  if (!resolvedTarget) {
    throw new Error("No current delivery window slot for today — cannot roll lagwad");
  }

  const { pendingLagwadBySlot } = buildPendingLagwadBucketsFromSlots(slots, asOfDate);
  if (!pendingLagwadBySlot.length) {
    return {
      targetSlotId: resolvedTarget,
      slotsRolled: 0,
      actualMoved: 0,
      readyMoved: 0,
      errors: [],
    };
  }

  let slotsRolled = 0;
  let actualMoved = 0;
  let readyMoved = 0;
  const errors = [];

  for (const bucket of pendingLagwadBySlot) {
    const readyQty = bucket.actualReadyPlants || 0;
    if (readyQty < 1) continue;

    try {
      await runRollExpiredSlotAvailable({
        targetSlotId: resolvedTarget,
        transfers: [
          {
            sourceSlotId: bucket.slotId,
            availableQty: 0,
            actualQty: 0,
            readyQty,
          },
        ],
        reason,
        performedBy,
        asOfDate,
        rollKind: "expired_manual",
      });
      slotsRolled += 1;
      readyMoved += readyQty;
    } catch (err) {
      errors.push({
        sourceSlotId: bucket.slotId,
        label: bucket.label,
        reason: err?.message || String(err),
      });
    }
  }

  return {
    targetSlotId: resolvedTarget,
    slotsRolled,
    actualMoved,
    readyMoved,
    errors,
  };
}

export async function getRolledLagwadSummary(slotId, { trailLimit = 30, logLimit = 100 } = {}) {
  if (!mongoose.isValidObjectId(String(slotId))) {
    throw new Error("Invalid slot id");
  }
  const slotObjectId = new mongoose.Types.ObjectId(String(slotId));

  const agg = await PlantSlot.aggregate([
    { $match: { "subtypeSlots.slots._id": slotObjectId } },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $match: { "subtypeSlots.slots._id": slotObjectId } },
    {
      $project: {
        slot: "$subtypeSlots.slots",
      },
    },
    { $limit: 1 },
  ]);

  const slot = agg[0]?.slot;
  if (!slot) {
    throw new Error("Slot not found");
  }

  const readyRollLog = await listReadyRollLogForSlot(slotId, { limit: logLimit });
  const readySummary = await summarizeReadyRollForSlot(slotId);

  const trail = Array.isArray(slot.slotTrail) ? slot.slotTrail : [];
  const actualRollRecent = trail
    .filter(
      (t) =>
        t.action === SLOT_TRAIL_ACTIONS.EXPIRED_ACTUAL_ROLL_IN ||
        t.action === SLOT_TRAIL_ACTIONS.EXPIRED_READY_ROLL_IN
    )
    .slice(0, Math.min(100, trailLimit))
    .map((t) => ({
      action: t.action,
      quantity: Number(t.quantity) || 0,
      reason: t.reason || t.notes || "",
      createdAt: t.createdAt,
      metadata: t.metadata || {},
    }));

  return {
    slotId: String(slotId),
    startDay: slot.startDay,
    endDay: slot.endDay,
    actualPlants: Number(slot.actualPlants) || 0,
    actualReadyPlants: Number(slot.actualReadyPlants) || 0,
    rolledInActualReadyPlants: Number(slot.rolledInActualReadyPlants) || 0,
    readyRollLog,
    readySummary,
    actualRollRecent,
  };
}

export { isSlotExpiredByEndDay };
