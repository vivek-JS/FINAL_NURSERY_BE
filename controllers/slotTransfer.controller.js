import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import { isOfficeOrSuper, applyTransfer } from "./orderSowFromExcess.controller.js";

function slotLabel(slot) {
  if (!slot) return "—";
  if (!slot.endDay || slot.startDay === slot.endDay) return slot.startDay || "—";
  return `${slot.startDay} → ${slot.endDay}`;
}

async function loadSlotRow(slotId) {
  if (!slotId || !mongoose.Types.ObjectId.isValid(String(slotId))) return null;
  const sid = new mongoose.Types.ObjectId(slotId);
  const rows = await PlantSlot.aggregate([
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $match: { "subtypeSlots.slots._id": sid } },
    {
      $project: {
        plantId: "$plantId",
        subtypeId: "$subtypeSlots.subtypeId",
        slotId: "$subtypeSlots.slots._id",
        startDay: "$subtypeSlots.slots.startDay",
        endDay: "$subtypeSlots.slots.endDay",
        availablePlants: { $ifNull: ["$subtypeSlots.slots.availablePlants", 0] },
        primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
        totalPlants: { $ifNull: ["$subtypeSlots.slots.totalPlants", 0] },
      },
    },
    { $limit: 1 },
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    label: slotLabel(row),
    availablePlants: Math.max(0, Number(row.availablePlants) || 0),
  };
}

async function loadSiblingSlots(plantId, subtypeId, excludeSlotId) {
  const pid = new mongoose.Types.ObjectId(plantId);
  const stid = new mongoose.Types.ObjectId(subtypeId);
  const rows = await PlantSlot.aggregate([
    { $match: { plantId: pid } },
    { $unwind: "$subtypeSlots" },
    { $match: { "subtypeSlots.subtypeId": stid } },
    { $unwind: "$subtypeSlots.slots" },
    {
      $project: {
        slotId: "$subtypeSlots.slots._id",
        startDay: "$subtypeSlots.slots.startDay",
        endDay: "$subtypeSlots.slots.endDay",
        availablePlants: { $ifNull: ["$subtypeSlots.slots.availablePlants", 0] },
        primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
        totalPlants: { $ifNull: ["$subtypeSlots.slots.totalPlants", 0] },
      },
    },
  ]);
  return rows
    .filter((r) => String(r.slotId) !== String(excludeSlotId))
    .map((r) => ({
      slotId: String(r.slotId),
      label: slotLabel(r),
      availablePlants: Math.max(0, Number(r.availablePlants) || 0),
      primarySowed: Number(r.primarySowed) || 0,
      totalPlants: Number(r.totalPlants) || 0,
    }));
}

/**
 * GET /sowing/slot/:slotId/transfer-targets
 * Sibling slots for slot-to-slot move (sources with stock, all as destinations).
 */
export const getSlotTransferTargets = async (req, res) => {
  try {
    if (!isOfficeOrSuper(req.user)) {
      return res.status(403).json({ success: false, message: "Office Admin or Super Admin only" });
    }
    const ctx = await loadSlotRow(req.params.slotId);
    if (!ctx) {
      return res.status(404).json({ success: false, message: "Slot not found" });
    }
    const siblings = await loadSiblingSlots(ctx.plantId, ctx.subtypeId, ctx.slotId);
    return res.status(200).json({
      success: true,
      data: {
        slot: {
          slotId: String(ctx.slotId),
          label: ctx.label,
          availablePlants: ctx.availablePlants,
        },
        sources: siblings.filter((s) => s.availablePlants > 0),
        destinations: siblings,
      },
    });
  } catch (error) {
    console.error("getSlotTransferTargets:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /sowing/slot/:fromSlotId/transfer-to-slot
 * Body: { toSlotId, plants }
 */
export const transferSlotToSlot = async (req, res) => {
  try {
    if (!isOfficeOrSuper(req.user)) {
      return res.status(403).json({ success: false, message: "Office Admin or Super Admin only" });
    }
    const { fromSlotId } = req.params;
    const { toSlotId, plants } = req.body || {};
    const qty = Math.max(0, Math.floor(Number(plants) || 0));
    if (!toSlotId || !mongoose.Types.ObjectId.isValid(String(toSlotId))) {
      return res.status(400).json({ success: false, message: "Valid toSlotId required" });
    }
    if (qty <= 0) {
      return res.status(400).json({ success: false, message: "plants must be > 0" });
    }
    if (String(fromSlotId) === String(toSlotId)) {
      return res.status(400).json({ success: false, message: "Source and destination must differ" });
    }

    const from = await loadSlotRow(fromSlotId);
    const to = await loadSlotRow(toSlotId);
    if (!from || !to) {
      return res.status(404).json({ success: false, message: "Slot not found" });
    }
    if (
      String(from.plantId) !== String(to.plantId) ||
      String(from.subtypeId) !== String(to.subtypeId)
    ) {
      return res.status(400).json({ success: false, message: "Slots must be same plant and subtype" });
    }
    if (from.availablePlants < qty) {
      return res.status(400).json({
        success: false,
        message: `Only ${from.availablePlants} available on source slot`,
      });
    }

    const ok = await applyTransfer({
      fromSlotId: String(from.slotId),
      toSlotId: String(to.slotId),
      take: qty,
      excessDec: 0,
      sameSlot: false,
    });
    if (!ok) {
      return res.status(409).json({ success: false, message: "Transfer failed — insufficient stock" });
    }

    const now = new Date();
    const userId = req.user?._id || null;
    const trailOut = {
      at: now,
      action: "SLOT_TO_SLOT_OUT",
      plants: qty,
      toSlotId: String(to.slotId),
      toLabel: to.label,
      by: userId,
    };
    const trailIn = {
      at: now,
      action: "SLOT_TO_SLOT_IN",
      plants: qty,
      fromSlotId: String(from.slotId),
      fromLabel: from.label,
      by: userId,
    };

    await PlantSlot.updateOne(
      { "subtypeSlots.slots._id": new mongoose.Types.ObjectId(from.slotId) },
      { $push: { "subtypeSlots.$[st].slots.$[sl].slotTrail": trailOut } },
      { arrayFilters: [{ "st.slots._id": new mongoose.Types.ObjectId(from.slotId) }, { "sl._id": new mongoose.Types.ObjectId(from.slotId) }] }
    );
    await PlantSlot.updateOne(
      { "subtypeSlots.slots._id": new mongoose.Types.ObjectId(toSlotId) },
      { $push: { "subtypeSlots.$[st].slots.$[sl].slotTrail": trailIn } },
      { arrayFilters: [{ "st.slots._id": new mongoose.Types.ObjectId(toSlotId) }, { "sl._id": new mongoose.Types.ObjectId(toSlotId) }] }
    );

    return res.status(200).json({
      success: true,
      message: `Moved ${qty} plants ${from.label} → ${to.label}`,
      data: { fromSlotId, toSlotId, plants: qty },
    });
  } catch (error) {
    console.error("transferSlotToSlot:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
