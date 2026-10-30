import mongoose from "mongoose";
import moment from "moment";
import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import { DISPATCH_DUE_STATUSES } from "../utility/dispatchLagwadBuckets.js";
import { createShortTtlCache } from "../utility/shortTtlCache.js";

const ORDER_SELECT =
  "-_id orderStatus numberOfPlants additionalPlants remainingPlants deliveryDate quotaSource vehicleLoaded vehicleLoadedQuantity";
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const sharedCache = createShortTtlCache(30_000);
const cropCache = createShortTtlCache(5 * 60_000);

async function cached(cache, key, load) {
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = load();
  cache.set(key, pending);
  try {
    return await pending;
  } catch (err) {
    cache.clear();
    throw err;
  }
}

export async function loadSlotIdSet(plantId, subtypeId, fromYear, toYear) {
  const years = [];
  for (let y = fromYear - 1; y <= toYear; y += 1) years.push(y);
  const docs = await PlantSlot.find({ plantId: oid(plantId), year: { $in: years } })
    .select("-_id subtypeSlots.subtypeId subtypeSlots.slots._id")
    .lean();
  const ids = new Set();
  for (const doc of docs) {
    for (const st of doc.subtypeSlots || []) {
      if (subtypeId && String(st.subtypeId) !== String(subtypeId)) continue;
      for (const slot of st.slots || []) if (slot?._id) ids.add(String(slot._id));
    }
  }
  return ids;
}

export function loadDueOrders({ plantId, subtypeId, rangeStart, rangeEnd }) {
  const filter = {
    plantName: oid(plantId),
    orderStatus: { $in: DISPATCH_DUE_STATUSES },
    deliveryDate: { $gte: rangeStart, $lte: rangeEnd },
    $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }],
  };
  if (subtypeId) filter.plantSubtype = oid(subtypeId);
  return Order.find(filter).select(ORDER_SELECT).lean();
}

/**
 * Every unsold, slot-linked lagwad entry across all crops (one lean pass, shared cache).
 * expectedReadyDate is materialized on the line; batch ready days only fill legacy gaps.
 */
export function loadOpenLagwadLines() {
  return cached(sharedCache, "lagwad-lines", async () => {
    const rows = await PlantOutward.aggregate([
      { $match: { "secondaryInward.availableQuantity": { $gt: 0 } } },
      { $unwind: "$secondaryInward" },
      { $match: { "secondaryInward.availableQuantity": { $gt: 0 }, "secondaryInward.linkedBookingSlotId": { $ne: null } } },
      {
        $project: {
          _id: 0,
          batchId: 1,
          slotId: "$secondaryInward.linkedBookingSlotId",
          availableQuantity: "$secondaryInward.availableQuantity",
          expectedReadyDate: "$secondaryInward.expectedReadyDate",
          inwardDate: "$secondaryInward.secondaryInwardDate",
        },
      },
    ]);
    const missing = [...new Set(rows.filter((r) => !r.expectedReadyDate && r.inwardDate).map((r) => String(r.batchId)))];
    const readyDays = new Map();
    if (missing.length) {
      const batches = await DispatchBatch.find({ _id: { $in: missing.map(oid) } }).select("secondaryPlantReadyDays").lean();
      for (const b of batches) readyDays.set(String(b._id), Number(b.secondaryPlantReadyDays) || 0);
    }
    return rows.map((r) => ({
      slotId: String(r.slotId),
      availableQuantity: r.availableQuantity,
      expectedReadyDate:
        r.expectedReadyDate ||
        (r.inwardDate ? moment(r.inwardDate).add(readyDays.get(String(r.batchId)) || 0, "days").toDate() : null),
    }));
  });
}

/** Crops that have booking slots around this year, with their slotted subtypes. */
export function loadCropOptions() {
  return cached(cropCache, "crops", async () => {
    const year = moment().year();
    const slotDocs = await PlantSlot.find({ year: { $in: [year - 1, year, year + 1] } })
      .select("-_id plantId subtypeSlots.subtypeId")
      .lean();
    const subsByPlant = new Map();
    for (const doc of slotDocs) {
      const key = String(doc.plantId);
      if (!subsByPlant.has(key)) subsByPlant.set(key, new Set());
      for (const st of doc.subtypeSlots || []) subsByPlant.get(key).add(String(st.subtypeId));
    }
    const plants = await PlantCms.find({ _id: { $in: [...subsByPlant.keys()].map(oid) } })
      .select("name subtypes._id subtypes.name")
      .lean();
    return plants
      .map((p) => {
        const wanted = subsByPlant.get(String(p._id));
        return {
          plantId: String(p._id),
          plantName: p.name,
          subtypes: (p.subtypes || [])
            .filter((s) => wanted.has(String(s._id)))
            .map((s) => ({ subtypeId: String(s._id), subtypeName: s.name }))
            .sort((a, b) => a.subtypeName.localeCompare(b.subtypeName)),
        };
      })
      .filter((p) => p.subtypes.length)
      .sort((a, b) => a.plantName.localeCompare(b.plantName));
  });
}

export async function resolveCropContext(plantId, subtypeId) {
  const crops = await loadCropOptions();
  let crop = crops.find((c) => c.plantId === String(plantId));
  if (!crop) {
    const p = await PlantCms.findById(plantId).select("name subtypes._id subtypes.name").lean();
    crop = { plantName: p?.name || "", subtypes: (p?.subtypes || []).map((s) => ({ subtypeId: String(s._id), subtypeName: s.name })) };
  }
  const sub = subtypeId ? crop.subtypes.find((s) => s.subtypeId === String(subtypeId)) : null;
  return {
    plantId: String(plantId),
    plantName: crop.plantName,
    subtypeId: subtypeId ? String(subtypeId) : null,
    subtypeName: sub?.subtypeName || (subtypeId ? "" : "All varieties"),
  };
}
