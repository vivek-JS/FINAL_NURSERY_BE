import mongoose from "mongoose";
import Order from "../../models/order.model.js";
import SowingEntry from "../../models/sowingEntry.model.js";
import { excessWindowCapForPlant } from "../../services/orderExcessBatchCover.service.js";
import { plantsFromThisEntry } from "./linkedOrdersForEntry.js";
import { toSowingEntryListItem } from "./mapSowingEntry.js";
import { collectionExcessRows, releasedPlantsForEntry } from "./collectionExcess.js";

const ENTRY_FIELDS = [
  "requestNumber",
  "plantName",
  "subtypeName",
  "sowingDate",
  "sowDay",
  "plantReadyDate",
  "plantsSowed",
  "orderCoveredPlants",
  "excessPlants",
  "bufferPlants",
  "mortalityMovedToExcess",
  "noMortalityReserve",
  "isIrrelevant",
  "sourceBatchId",
  "sowingRequestId",
  "linkedOrderIds",
].join(" ");

function oid(value) {
  const text = String(value || "").trim();
  return mongoose.Types.ObjectId.isValid(text) ? new mongoose.Types.ObjectId(text) : null;
}

/**
 * GET /sowing/entries/excess
 * Same window as the existing excess popup. Reads sowingentries only.
 */
export async function getCollectionExcess(req, res) {
  const plantId = oid(req.query.plantId);
  const subtypeId = oid(req.query.subtypeId);
  const deliveryDate = String(req.query.deliveryDate || "").trim();
  if (!plantId || !subtypeId || !deliveryDate) {
    return res.status(400).json({
      success: false,
      message: "plantId, subtypeId and deliveryDate are required",
    });
  }
  const releaseId = oid(req.query.releaseOrderId);
  const plantCap = await excessWindowCapForPlant(plantId);
  const requested = Math.max(0, Math.floor(Number(req.query.windowDays) || 3));
  const pastRequested = Math.max(0, Math.floor(Number(req.query.pastWindowDays) || 12));
  const papaya = plantCap > 15;
  const windowDays = papaya ? plantCap : Math.min(plantCap, requested);
  const pastWindowDays = papaya ? plantCap : Math.min(plantCap, pastRequested);

  const filter = {
    plantId,
    subtypeId,
    isIrrelevant: { $ne: true },
    ...(releaseId
      ? { $or: [{ excessPlants: { $gt: 0 } }, { linkedOrderIds: releaseId }] }
      : { excessPlants: { $gt: 0 } }),
  };
  const [docs, order] = await Promise.all([
    SowingEntry.find(filter).select(ENTRY_FIELDS).lean(),
    releaseId ? Order.findById(releaseId).select("sowingCoverSources").lean() : null,
  ]);
  const releasedById = new Map();
  for (const doc of docs) {
    const extra = releasedPlantsForEntry(doc, order?.sowingCoverSources || []);
    if (extra > 0) releasedById.set(String(doc._id), extra);
  }
  const data = collectionExcessRows(docs, {
    deliveryDate,
    windowDays,
    pastWindowDays,
    releasedById,
  });
  const need = Math.max(0, Math.floor(Number(req.query.need) || 0));
  return res.json({
    success: true,
    source: "sowingentries",
    data: {
      need,
      windowDays,
      pastWindowDays,
      totalFree: data.totalFree,
      mode: data.totalFree < 1 ? "none" : need > 0 && data.totalFree >= need ? "full" : "partial",
      entries: data.entries,
    },
  });
}

/** GET /sowing/entries/for-order?orderId= — entries that list this order. */
export async function getSowingEntriesForOrder(req, res) {
  const orderId = oid(req.query.orderId);
  if (!orderId) return res.status(400).json({ success: false, message: "orderId is required" });
  const [docs, order] = await Promise.all([
    SowingEntry.find({ linkedOrderIds: orderId }).sort({ sowDay: -1, requestNumber: -1 }).lean(),
    Order.findById(orderId)
      .select("sowingCoverSources sowingPartialCover sowingDoneRequestId numberOfPlants additionalPlants")
      .lean(),
  ]);
  return res.json({
    success: true,
    source: "sowingentries",
    items: docs.map((doc) => ({
      ...toSowingEntryListItem(doc),
      plantsForThisOrder: plantsFromThisEntry(order || {}, doc),
    })),
  });
}
