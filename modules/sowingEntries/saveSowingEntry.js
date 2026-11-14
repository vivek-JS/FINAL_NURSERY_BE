import mongoose from "mongoose";
import PlantCms from "../../models/plantCms.model.js";
import PlantSlot from "../../models/slots.model.js";
import SowingEntry from "../../models/sowingEntry.model.js";
import { excessFieldsForBatch } from "../../utility/sowingBatchExcessStamp.js";
import { sellablePlantsOf } from "../../services/sowBatchStock.service.js";

function cmsPctOf(plant) {
  if (plant?.sowingMortality != null && Number.isFinite(Number(plant.sowingMortality))) {
    return Math.max(0, Number(plant.sowingMortality));
  }
  if (plant?.sowingBuffer != null && Number.isFinite(Number(plant.sowingBuffer))) {
    return Math.max(0, Number(plant.sowingBuffer));
  }
  return 0;
}
import { sowDayFrom } from "./mapSowingEntry.js";

const intQty = (value) => Math.max(0, Math.floor(Number(value) || 0));

/** A dustbin mark on the sowing entry stays when a later copy still says relevant. */
export function keepMarkedOld(doc, alreadyOld) {
  if (!alreadyOld || doc?.isIrrelevant) return doc;
  return { ...doc, isIrrelevant: true, excessPlants: 0 };
}

/** Fields written when the dustbin marks or restores one sowing entry. */
export function entryIrrelevantPatch(doc, mark) {
  const next = { ...(doc?.toObject ? doc.toObject() : doc), isIrrelevant: Boolean(mark) };
  const excess = mark ? 0 : excessFieldsForBatch(next, next.sowingBufferPct || 0).shownExcess;
  return { isIrrelevant: Boolean(mark), excessPlants: excess };
}

/** Same numbers as the sowing-entries table. Blank % uses plant CMS. Ready plants stay at 0. */
export function sowingEntryFromBatch(batch, { plantId, plantName = "", subtypeId = null, subtypeName = "", year = null, cmsPct = 0 } = {}) {
  const rawPct = batch?.sowingBufferPct;
  const noMortalityReserve = Boolean(batch?.noMortalityReserve);
  const usePct = noMortalityReserve ? 0 : rawPct == null ? cmsPct : Number(rawPct) || 0;
  const fields = excessFieldsForBatch(batch, usePct);
  return {
    sourceBatchId: batch._id,
    sowingRequestId: batch.sowingRequestId || null,
    requestNumber: batch.requestNumber || "",
    plantId,
    plantName,
    subtypeId: subtypeId || null,
    subtypeName,
    shedName: batch.shedName || "",
    year,
    sowingDate: batch.sowingDate || "",
    sowDay: sowDayFrom(batch.sowingDate),
    plantReadyDate: batch.plantReadyDate || "",
    out: batch.out || "",
    plantsSowed: intQty(batch.plantsSowed),
    destroyedPlants: intQty(batch.destroyedPlants),
    orderCoveredPlants: intQty(batch.orderCoveredPlants),
    sowingBufferPct: fields.sowingBufferPct,
    bufferPlants: fields.bufferPlants,
    excessPlants: batch.isIrrelevant ? 0 : fields.shownExcess,
    mortalityMovedToExcess: intQty(batch.mortalityMovedToExcess),
    excessMovedToMortality: intQty(batch.excessMovedToMortality),
    noMortalityReserve,
    entryKind: batch.entryKind === "komb" || batch.entryKind === "excess" ? batch.entryKind : "sowing",
    sourceEntryId: batch.sourceEntryId || null,
    isIrrelevant: Boolean(batch.isIrrelevant),
    linkedOrderIds: batch.linkedOrderIds || [],
    ...(Array.isArray(batch.orderCovers) ? { orderCovers: batch.orderCovers } : {}),
  };
}

async function slotIdentity(slotId) {
  const id = new mongoose.Types.ObjectId(String(slotId));
  const rows = await PlantSlot.aggregate([
    { $match: { "subtypeSlots.slots._id": id } },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $match: { "subtypeSlots.slots._id": id } },
    { $project: { plantId: 1, year: 1, subtypeId: "$subtypeSlots.subtypeId" } },
    { $limit: 1 },
  ]);
  return rows[0] || null;
}

/**
 * One sowingentries row for this request. Plant and variety come from the request.
 * Does not read or write a calendar slot.
 */
export async function upsertSowingEntryForRequest(request, batch) {
  if (!request?._id || !batch) return null;
  const plantId = request.plantId || batch.plantId;
  if (!plantId) return null;
  const plant = await PlantCms.findById(plantId)
    .select("name subtypes._id subtypes.name sowingMortality sowingBuffer")
    .lean();
  const subtype = (plant?.subtypes || []).find(
    (row) => String(row._id) === String(request.subtypeId || batch.subtypeId)
  );
  const existing = await SowingEntry.findOne({ sowingRequestId: request._id })
    .select("sourceBatchId isIrrelevant")
    .lean();
  const sourceBatchId = existing?.sourceBatchId || batch._id || new mongoose.Types.ObjectId();
  const sowDay = sowDayFrom(batch.sowingDate);
  const yearNum = Number(String(sowDay).slice(0, 4));
  const doc = keepMarkedOld(
    sowingEntryFromBatch(
      {
        ...batch,
        _id: sourceBatchId,
        sowingRequestId: request._id,
        requestNumber: batch.requestNumber || request.requestNumber || "",
      },
      {
        plantId,
        plantName: plant?.name || request.plantName || "",
        subtypeId: request.subtypeId || batch.subtypeId || null,
        subtypeName: subtype?.name || request.subtypeName || "",
        year: Number.isFinite(yearNum) && yearNum > 2000 ? yearNum : null,
        cmsPct: cmsPctOf(plant),
      }
    ),
    existing?.isIrrelevant
  );
  await SowingEntry.updateOne(
    { sowingRequestId: request._id },
    {
      $set: doc,
      $setOnInsert: {
        dispatchedPlants: 0,
        remainingPlants: sellablePlantsOf(doc),
      },
    },
    { upsert: true }
  );
  return doc;
}

/** After the slot batch is saved, keep one sowingentries document for it. */
export async function upsertSowingEntryFromBatch(batch, slotId, session = null) {
  if (!batch?._id || !slotId) return null;
  const slot = await slotIdentity(slotId);
  if (!slot?.plantId) return null;
  const plant = await PlantCms.findById(slot.plantId)
    .select("name subtypes._id subtypes.name sowingMortality sowingBuffer")
    .lean();
  const subtype = (plant?.subtypes || []).find((row) => String(row._id) === String(slot.subtypeId));
  let prior = SowingEntry.findOne({ sourceBatchId: batch._id }).select("isIrrelevant");
  if (session) prior = prior.session(session);
  const existing = await prior.lean();
  const doc = keepMarkedOld(
    sowingEntryFromBatch(batch, {
      plantId: slot.plantId,
      plantName: plant?.name || "",
      subtypeId: slot.subtypeId,
      subtypeName: subtype?.name || "",
      year: slot.year ?? null,
      cmsPct: cmsPctOf(plant),
    }),
    existing?.isIrrelevant
  );
  await SowingEntry.updateOne(
    { sourceBatchId: batch._id },
    {
      $set: doc,
      // This counter starts at 0. Older vehicle logs are not copied onto it.
      $setOnInsert: {
        dispatchedPlants: 0,
        remainingPlants: sellablePlantsOf(batch),
      },
    },
    { upsert: true, ...(session ? { session } : {}) }
  );
  return doc;
}

/** The slot batch was removed, so the sowing entry goes with it. */
export async function removeSowingEntryForBatch(batchId) {
  if (!batchId) return;
  await SowingEntry.deleteOne({ sourceBatchId: batchId });
}
