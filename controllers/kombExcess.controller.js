import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import SowingEntry from "../models/sowingEntry.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import {
  applyPlantsToLinkedSlots,
  findSowBatchForRequest,
} from "./sowingCompleteHelpers.js";
import { fmtDDMMYYYY, parseLocalDate } from "./sowingSlotReadyHelpers.js";
import { excessFieldsForBatch } from "../utility/sowingBatchExcessStamp.js";

const ALLOWED = new Set([
  "SUPER_ADMIN",
  "SUPERADMIN",
  "OFFICE_ADMIN",
  "OFFICEADMIN",
  "SECONDARY",
  "SECONDARY_ADMIN",
  "SHED",
  "SHED_OPS",
]);

function allowed(user) {
  const role = String(user?.jobTitle || user?.role || "").toUpperCase();
  return ALLOWED.has(role);
}

function todayNoon() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
}

/** Add plants onto a sowing and keep the old mortality buffer. */
async function addOntoEntry(entryId, qty, readyNow, sowedAt) {
  if (!mongoose.Types.ObjectId.isValid(String(entryId || ""))) {
    const err = new Error("Choose a sowing to update");
    err.status = 400;
    throw err;
  }
  const entry = await SowingEntry.findById(entryId);
  if (!entry) {
    const err = new Error("Sowing not found");
    err.status = 404;
    throw err;
  }
  const add = Math.max(0, Math.floor(Number(qty) || 0));
  const oldBuffer = entry.noMortalityReserve
    ? 0
    : Math.max(0, Math.floor(Number(entry.bufferPlants) || 0));
  const newSowed = Math.max(0, Math.floor(Number(entry.plantsSowed) || 0)) + add;
  entry.plantsSowed = newSowed;
  if (oldBuffer <= 0) {
    entry.noMortalityReserve = true;
    entry.sowingBufferPct = 0;
    entry.bufferPlants = 0;
  } else {
    entry.sowingBufferPct = (oldBuffer * 100) / newSowed;
    entry.bufferPlants = oldBuffer;
  }
  const fields = excessFieldsForBatch(entry.toObject(), entry.sowingBufferPct);
  entry.bufferPlants = fields.bufferPlants;
  entry.sowingBufferPct = fields.sowingBufferPct;
  entry.excessPlants = fields.shownExcess;
  const dispatched = Math.max(0, Math.floor(Number(entry.dispatchedPlants) || 0));
  const mortality = entry.noMortalityReserve ? 0 : fields.bufferPlants;
  entry.remainingPlants = Math.max(0, newSowed - mortality - dispatched);
  if (readyNow) entry.plantReadyDate = fmtDDMMYYYY(sowedAt);
  await entry.save();

  if (entry.sowingRequestId) {
    const batches = await findSowBatchForRequest(entry.sowingRequestId);
    const batchId = batches[0]?.batch?._id;
    if (batchId) {
      await PlantSlot.updateOne(
        { "subtypeSlots.slots.sowingBatches._id": batchId },
        {
          $set: {
            "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].plantsSowed": newSowed,
            "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].sowingBufferPct": entry.sowingBufferPct,
            "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].bufferPlants": entry.bufferPlants,
            "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].excessPlants": entry.excessPlants,
            "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].noMortalityReserve": Boolean(
              entry.noMortalityReserve
            ),
            ...(readyNow
              ? {
                  "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].plantReadyDate":
                    entry.plantReadyDate,
                  "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].plantReadyDays": 0,
                }
              : {}),
          },
        },
        {
          arrayFilters: [
            { "st.slots.sowingBatches._id": batchId },
            { "sl.sowingBatches._id": batchId },
            { "b._id": batchId },
          ],
        }
      );
    }
  }
  return entry;
}

/**
 * POST /sowing/komb-excess
 * Komb: number of komb, ready in 30 days, no packets and no mortality.
 * Excess: plants still left from a sowing, as a new entry or added onto that sowing.
 */
export async function submitKombExcess(req, res) {
  try {
    if (!allowed(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Not allowed to save komb or excess",
      });
    }

    const kind = String(req.body.kind || "").trim().toLowerCase();
    if (kind !== "komb" && kind !== "excess") {
      return res.status(400).json({
        success: false,
        message: "kind must be komb or excess",
      });
    }

    const plantsSowed = Math.floor(Number(req.body.plantsSowed) || 0);
    if (plantsSowed <= 0) {
      return res.status(400).json({
        success: false,
        message:
          kind === "komb"
            ? "Enter the number of komb"
            : "Enter how many plants are still there",
      });
    }

    const sowedAt = parseLocalDate(req.body.sowDate || req.body.date) || todayNoon();
    const shedName = String(req.body.shedName || "Office").trim() || "Office";
    const readyNow = req.body.readyNow === true || req.body.readyNow === "true";
    const updateEntryId = String(req.body.updateEntryId || "").trim();

    if (kind === "excess" && updateEntryId) {
      const entry = await addOntoEntry(updateEntryId, plantsSowed, readyNow, sowedAt);
      return res.status(200).json({
        success: true,
        message: "Sowing updated",
        data: {
          entryId: entry._id,
          plantsSowed: entry.plantsSowed,
          updated: true,
        },
      });
    }

    const plantId = String(req.body.plantId || "");
    const subtypeId = String(req.body.subtypeId || "");
    if (
      !mongoose.Types.ObjectId.isValid(plantId) ||
      !mongoose.Types.ObjectId.isValid(subtypeId)
    ) {
      return res.status(400).json({ success: false, message: "Choose a variety" });
    }

    const plant = await PlantCms.findById(plantId)
      .select("name subtypes sowingAllowed")
      .lean();
    if (!plant?.sowingAllowed) {
      return res.status(400).json({
        success: false,
        message: "Plant is not sowing-allowed",
      });
    }
    const subtype = (plant.subtypes || []).find((row) => String(row._id) === subtypeId);
    if (!subtype) {
      return res.status(404).json({ success: false, message: "Subtype not found" });
    }

    let plantReadyDays = Math.floor(Number(req.body.plantReadyDays));
    if (readyNow) plantReadyDays = 0;
    else if (!Number.isFinite(plantReadyDays) || plantReadyDays < 0) {
      plantReadyDays = kind === "komb" ? 30 : Math.max(0, Number(subtype.plantReadyDays) || 30);
    }

    const sourceRaw = String(req.body.sourceEntryId || "");
    const sourceEntryId = mongoose.Types.ObjectId.isValid(sourceRaw)
      ? new mongoose.Types.ObjectId(sourceRaw)
      : null;
    const requestNumber = await SowingRequest.generateRequestNumber();
    const label = kind === "komb" ? "Komb" : "Excess";
    const request = new SowingRequest({
      requestNumber,
      plantId,
      plantName: plant.name,
      subtypeId,
      subtypeName: subtype.name,
      packetsNeeded: 0,
      packetsRequested: 0,
      excessPackets: 0,
      conversionFactor: 1,
      status: "issued",
      requestedBy: req.user._id,
      issuedBy: req.user._id,
      issuedDate: sowedAt,
      notes: `${label} sow`,
      linkedSlotIds: [],
      linkedOrderIds: [],
      isExcessiveSowing: true,
      packetsFromCompany: 0,
      packetsFromRaising: 0,
      packetsIssued: 0,
      packetsUsed: 0,
      packetsReturned: 0,
      sowedQuantity: plantsSowed,
      shedName,
      completionNotes: `${label} · ${plantsSowed} · no mortality`,
      completedBy: req.user._id,
      sowingCompleted: true,
      sowingCompletedDate: sowedAt,
      sowingInProgress: false,
      remainingSowingNeeded: 0,
      completionEvents: [],
    });

    const saved = await applyPlantsToLinkedSlots(request, plantsSowed, {
      requestNumber,
      linkedOrderIds: [],
      isExcessiveSowing: true,
      entryKind: kind,
      sourceEntryId,
      shedName,
      sowedAt,
      plantReadyDays,
      mortalityPct: 0,
      excessPlants: plantsSowed,
    });
    await request.saveWithUniqueRequestNumber();

    return res.status(201).json({
      success: true,
      message: kind === "komb" ? "Komb saved" : "Excess saved",
      data: {
        requestId: request._id,
        requestNumber: request.requestNumber,
        plantsSowed,
        entryKind: kind,
        plantReadyDays: saved.plantReadyDays ?? plantReadyDays,
        plantReadyDate: saved.plantReadyDate,
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Could not save",
    });
  }
}
