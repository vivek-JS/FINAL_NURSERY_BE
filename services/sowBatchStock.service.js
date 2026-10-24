import mongoose from "mongoose";
import moment from "moment";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import { IST_OFFSET } from "../utility/istSlotDate.js";
import { reportedExcessBreakdown } from "../utility/lagwadSlotPlantsSplit.js";
import { excessPlusMoved } from "./sowBatchMortalityRelease.service.js";
import { storedShownExcess } from "../utility/sowingBatchExcessStamp.js";

const n = (v) => Number(v) || 0;
const idStr = (v) => (v == null || v === "" ? "" : String(v._id ?? v));

export function dispatchedNetOf(batch) {
  return (batch?.dispatchLog || []).reduce((s, d) => s + n(d.plants), 0);
}

/** Remaining plants still on the batch after destroy + net dispatch (RETURN/UNLOAD are negative). */
export function remainingOf(batch, dispatchedNet) {
  const net = dispatchedNet == null ? dispatchedNetOf(batch) : n(dispatchedNet);
  return Math.max(0, n(batch?.plantsSowed) - n(batch?.destroyedPlants) - net);
}

export function changeCountOf(batch) {
  return (
    (batch?.dispatchLog?.length || 0) +
    (batch?.destroyLog?.length || 0) +
    (batch?.excessAllocations?.length || 0) +
    (batch?.slotHistory?.length || 0)
  );
}

export function linkedOrderIdSet(batch) {
  const ids = new Set();
  for (const id of batch?.linkedOrderIds || []) {
    const s = idStr(id);
    if (s) ids.add(s);
  }
  for (const a of batch?.excessAllocations || []) {
    const s = idStr(a?.orderId);
    if (s) ids.add(s);
  }
  return ids;
}

export function dmyToYmd(s) {
  const m = String(s || "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}

export function todayIstYmd() {
  return moment().utcOffset(IST_OFFSET).format("YYYY-MM-DD");
}

export function isReadyNow(plantReadyDate, todayYmd = todayIstYmd()) {
  const k = dmyToYmd(plantReadyDate);
  return Boolean(k) && k <= todayYmd;
}

export function orderRemainingPlants(order) {
  const booked = n(order?.numberOfPlants) + n(order?.additionalPlants);
  if (order?.sowingDone) return 0;
  const outstanding =
    order?.remainingPlants == null ? booked : Math.min(booked, Math.max(0, n(order.remainingPlants)));
  const held = (order?.sowingPartialCover || []).reduce((s, r) => s + n(r.plants), 0);
  return Math.max(0, outstanding - held);
}

export function mergeStockChanges(batch) {
  const changes = [];
  for (const d of batch?.dispatchLog || []) {
    changes.push({
      at: d.at || null,
      type: "dispatch",
      bucket: d.bucket || "",
      plants: n(d.plants),
      reason: d.reason || "",
      orderId: idStr(d.orderId),
      dispatchId: idStr(d.dispatchId),
    });
  }
  for (const d of batch?.destroyLog || []) {
    changes.push({
      at: d.at || null,
      type: "destroy",
      bucket: "",
      plants: -Math.abs(n(d.plants)),
      reason: d.reason || "",
      orderId: "",
      dispatchId: "",
    });
  }
  for (const a of batch?.excessAllocations || []) {
    changes.push({
      at: a.at || null,
      type: "excessAlloc",
      bucket: "",
      plants: n(a.plants),
      reason: "",
      orderId: idStr(a.orderId),
      dispatchId: "",
    });
  }
  for (const h of batch?.slotHistory || []) {
    changes.push({
      at: h.at || null,
      type: "slotMove",
      bucket: "",
      plants: n(h.plantsSowed),
      reason: h.reason || "",
      orderId: "",
      dispatchId: "",
      fromReadyDate: h.fromReadyDate || "",
      toReadyDate: h.toReadyDate || "",
    });
  }
  changes.sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime());
  return changes;
}

function oidOrNull(v) {
  return v && mongoose.Types.ObjectId.isValid(String(v))
    ? new mongoose.Types.ObjectId(String(v))
    : null;
}

async function sowingAllowedPlants(plantId) {
  const q = { sowingAllowed: true };
  const oid = oidOrNull(plantId);
  if (oid) q._id = oid;
  return PlantCms.find(q).select("_id name sowingBuffer subtypes._id subtypes.name").lean();
}

function mapOrderBrief(order, inProgress = false) {
  const booked = n(order.numberOfPlants) + n(order.additionalPlants);
  const held = (order.sowingPartialCover || []).reduce((s, r) => s + n(r.plants), 0);
  const remainingPlants = orderRemainingPlants(order);
  return {
    _id: String(order._id),
    orderId: order.orderId,
    farmerName: order.farmer?.name || order.name || "",
    sowingDone: Boolean(order.sowingDone),
    inProgress: !order.sowingDone && Boolean(inProgress),
    bookedPlants: booked,
    coveredPlants: order.sowingDone ? booked : held,
    remainingPlants,
  };
}

/** Order id → request number for an issued or in-progress sowing that is not finished. */
export async function inProgressRequestByOrderId(orderIds) {
  const ids = [...orderIds].filter((id) => mongoose.Types.ObjectId.isValid(String(id)));
  if (!ids.length) return new Map();
  const oids = ids.map((id) => new mongoose.Types.ObjectId(String(id)));
  const rows = await SowingRequest.find({
    sowingCompleted: { $ne: true },
    status: { $nin: ["cancelled", "rejected"] },
    $or: [{ sowingInProgress: true }, { status: "issued" }],
    linkedOrderIds: { $in: oids },
  })
    .select("linkedOrderIds requestNumber")
    .lean();
  const map = new Map();
  for (const row of rows) {
    for (const id of row.linkedOrderIds || []) {
      const key = String(id);
      if (!map.has(key)) map.set(key, row.requestNumber || "");
    }
  }
  return map;
}

/** Orders sitting on an issued or in-progress sowing that is not finished yet. */
export async function inProgressOrderIdSet(orderIds) {
  const byOrder = await inProgressRequestByOrderId(orderIds);
  return new Set(byOrder.keys());
}

async function hydrateOrders(idSet) {
  const ids = [...idSet].filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (!ids.length) return new Map();
  const rows = await Order.find({ _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } })
    .select("orderId name farmer numberOfPlants additionalPlants remainingPlants sowingDone sowingPartialCover")
    .populate("farmer", "name")
    .lean();
  const progress = await inProgressOrderIdSet(ids);
  const map = new Map();
  for (const o of rows) map.set(String(o._id), mapOrderBrief(o, progress.has(String(o._id))));
  return map;
}

function matchesQuery(row, q, orderMap) {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (
    String(row.plantName || "").toLowerCase().includes(needle) ||
    String(row.subtypeName || "").toLowerCase().includes(needle) ||
    String(row.requestNumber || "").toLowerCase().includes(needle) ||
    String(row.shedName || "").toLowerCase().includes(needle)
  ) {
    return true;
  }
  return (row.linkedOrderIds || []).some((id) => {
    const o = orderMap.get(String(id));
    return o && String(o.orderId || "").toLowerCase().includes(needle);
  });
}

function stockExcessOf(raw, plant) {
  if (raw?.isIrrelevant) return { excess: 0, bufferPlants: 0, bufferPct: 0 };
  if (raw?.shownExcess != null && raw?.sowingBufferPct != null) {
    return {
      excess: storedShownExcess(raw),
      bufferPlants: Math.max(0, Math.floor(Number(raw.bufferPlants) || 0)),
      bufferPct: Math.max(0, Number(raw.sowingBufferPct) || 0),
    };
  }
  const parts = reportedExcessBreakdown({
    plantsSowed: raw?.plantsSowed,
    orderCoveredPlants: raw?.orderCoveredPlants,
    sowingBufferPct: plant?.sowingBuffer,
  });
  return {
    excess: excessPlusMoved(parts.excess, raw),
    bufferPlants: parts.bufferPlants,
    bufferPct: parts.bufferPct,
  };
}

function toListRow(raw, plant, subtype, orderMap) {
  const remaining = remainingOf(raw, raw.dispatchedNet);
  const linkedIds = [...linkedOrderIdSet(raw)];
  const excess = stockExcessOf(raw, plant);
  return {
    batchId: String(raw._id),
    slotId: String(raw.slotId),
    plantId: String(raw.plantId),
    plantName: plant?.name || "",
    subtypeId: String(raw.subtypeId),
    subtypeName: subtype?.name || "",
    shedName: raw.shedName || "",
    requestNumber: raw.requestNumber || "",
    sowingRequestId: raw.sowingRequestId ? String(raw.sowingRequestId) : "",
    sowingDate: raw.sowingDate || "",
    plantReadyDate: raw.plantReadyDate || "",
    slotStartDay: raw.startDay || "",
    slotEndDay: raw.endDay || "",
    isExcessiveSowing: Boolean(raw.isExcessiveSowing),
    plantsSowed: n(raw.plantsSowed),
    destroyedPlants: n(raw.destroyedPlants),
    dispatchedNet: n(raw.dispatchedNet),
    remaining,
    covered: n(raw.orderCoveredPlants),
    excess: excess.excess,
    bufferPlants: excess.bufferPlants,
    sowingBufferPct: excess.bufferPct,
    isIrrelevant: Boolean(raw.isIrrelevant),
    reservedApplied: n(raw.orderReservedPlantsApplied),
    availableApplied: n(raw.availablePlantsApplied),
    changeCount: n(raw.changeCount),
    readyNow: isReadyNow(raw.plantReadyDate),
    linkedOrderIds: linkedIds,
    linkedOrders: linkedIds.map((id) => orderMap.get(id)).filter(Boolean),
  };
}

export async function listSowBatchStock(query = {}) {
  const plants = await sowingAllowedPlants(query.plantId);
  if (!plants.length) {
    return { items: [], total: 0, summary: { remaining: 0, sowed: 0, batches: 0 } };
  }
  const plantMap = new Map(plants.map((p) => [String(p._id), p]));
  const plantIds = plants.map((p) => p._id);
  const subtypeOid = oidOrNull(query.subtypeId);
  const shed = String(query.shed || "").trim().toLowerCase();
  const stock = String(query.stock || "all").toLowerCase();
  const ready = String(query.ready || "all").toLowerCase();
  const q = String(query.q || "").trim();

  const match = { plantId: { $in: plantIds }, "subtypeSlots.slots.sowingBatches.0": { $exists: true } };
  const pipeline = [
    { $match: match },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $unwind: "$subtypeSlots.slots.sowingBatches" },
  ];
  if (subtypeOid) pipeline.push({ $match: { "subtypeSlots.subtypeId": subtypeOid } });
  pipeline.push({
    $project: {
      plantId: 1,
      subtypeId: "$subtypeSlots.subtypeId",
      slotId: "$subtypeSlots.slots._id",
      startDay: "$subtypeSlots.slots.startDay",
      endDay: "$subtypeSlots.slots.endDay",
      _id: "$subtypeSlots.slots.sowingBatches._id",
      sowedAt: "$subtypeSlots.slots.sowingBatches.sowedAt",
      sowingDate: "$subtypeSlots.slots.sowingBatches.sowingDate",
      plantReadyDate: "$subtypeSlots.slots.sowingBatches.plantReadyDate",
      plantsSowed: "$subtypeSlots.slots.sowingBatches.plantsSowed",
      destroyedPlants: { $ifNull: ["$subtypeSlots.slots.sowingBatches.destroyedPlants", 0] },
      orderCoveredPlants: { $ifNull: ["$subtypeSlots.slots.sowingBatches.orderCoveredPlants", 0] },
      excessPlants: { $ifNull: ["$subtypeSlots.slots.sowingBatches.excessPlants", 0] },
      mortalityMovedToExcess: { $ifNull: ["$subtypeSlots.slots.sowingBatches.mortalityMovedToExcess", 0] },
      sowingBufferPct: "$subtypeSlots.slots.sowingBatches.sowingBufferPct",
      bufferPlants: "$subtypeSlots.slots.sowingBatches.bufferPlants",
      shownExcess: "$subtypeSlots.slots.sowingBatches.shownExcess",
      availablePlantsApplied: { $ifNull: ["$subtypeSlots.slots.sowingBatches.availablePlantsApplied", 0] },
      orderReservedPlantsApplied: {
        $ifNull: ["$subtypeSlots.slots.sowingBatches.orderReservedPlantsApplied", 0],
      },
      shedName: { $ifNull: ["$subtypeSlots.slots.sowingBatches.shedName", ""] },
      requestNumber: { $ifNull: ["$subtypeSlots.slots.sowingBatches.requestNumber", ""] },
      sowingRequestId: "$subtypeSlots.slots.sowingBatches.sowingRequestId",
      isExcessiveSowing: { $ifNull: ["$subtypeSlots.slots.sowingBatches.isExcessiveSowing", false] },
      isIrrelevant: { $ifNull: ["$subtypeSlots.slots.sowingBatches.isIrrelevant", false] },
      linkedOrderIds: { $ifNull: ["$subtypeSlots.slots.sowingBatches.linkedOrderIds", []] },
      excessAllocations: { $ifNull: ["$subtypeSlots.slots.sowingBatches.excessAllocations", []] },
      dispatchedNet: {
        $reduce: {
          input: { $ifNull: ["$subtypeSlots.slots.sowingBatches.dispatchLog", []] },
          initialValue: 0,
          in: { $add: ["$$value", { $ifNull: ["$$this.plants", 0] }] },
        },
      },
      changeCount: {
        $add: [
          { $size: { $ifNull: ["$subtypeSlots.slots.sowingBatches.dispatchLog", []] } },
          { $size: { $ifNull: ["$subtypeSlots.slots.sowingBatches.destroyLog", []] } },
          { $size: { $ifNull: ["$subtypeSlots.slots.sowingBatches.excessAllocations", []] } },
          { $size: { $ifNull: ["$subtypeSlots.slots.sowingBatches.slotHistory", []] } },
        ],
      },
    },
  });

  const rawRows = await PlantSlot.aggregate(pipeline).allowDiskUse(true);
  const allOrderIds = new Set();
  for (const r of rawRows) {
    for (const id of linkedOrderIdSet(r)) allOrderIds.add(id);
  }
  const orderMap = await hydrateOrders(allOrderIds);

  const items = [];
  for (const r of rawRows) {
    const plant = plantMap.get(String(r.plantId));
    if (!plant) continue;
    const subtype = (plant.subtypes || []).find((st) => String(st._id) === String(r.subtypeId));
    if (shed && !String(r.shedName || "").toLowerCase().includes(shed)) continue;
    if (stock === "remaining" && stockExcessOf(r, plant).excess <= 0) continue;
    const readyNow = isReadyNow(r.plantReadyDate);
    if (ready === "now" && !readyNow) continue;
    if (ready === "later" && readyNow) continue;
    const row = toListRow(r, plant, subtype, orderMap);
    if (!matchesQuery(row, q, orderMap)) continue;
    items.push(row);
  }

  items.sort((a, b) => b.remaining - a.remaining || String(b.sowingDate).localeCompare(String(a.sowingDate)));

  const summary = items.reduce(
    (s, r) => {
      s.remaining += r.remaining;
      s.sowed += r.plantsSowed;
      s.covered += r.covered;
      s.excess += r.isIrrelevant ? 0 : r.excess;
      s.destroyed += r.destroyedPlants;
      s.dispatched += r.dispatchedNet;
      s.batches += 1;
      return s;
    },
    { remaining: 0, sowed: 0, covered: 0, excess: 0, destroyed: 0, dispatched: 0, batches: 0 }
  );

  return { items, total: items.length, summary };
}

export async function getSowBatchStockDetail(batchId) {
  const oid = oidOrNull(batchId);
  if (!oid) return null;
  const doc = await PlantSlot.findOne({ "subtypeSlots.slots.sowingBatches._id": oid })
    .select("plantId subtypeSlots.subtypeId subtypeSlots.slots")
    .lean();
  if (!doc) return null;

  let found = null;
  for (const st of doc.subtypeSlots || []) {
    for (const sl of st.slots || []) {
      const batch = (sl.sowingBatches || []).find((b) => String(b._id) === String(oid));
      if (!batch) continue;
      found = { plantId: doc.plantId, subtypeId: st.subtypeId, slot: sl, batch };
      break;
    }
    if (found) break;
  }
  if (!found) return null;

  const plant = await PlantCms.findById(found.plantId)
    .select("name sowingAllowed sowingBuffer subtypes._id subtypes.name")
    .lean();
  if (!plant?.sowingAllowed) return null;
  const subtype = (plant.subtypes || []).find((st) => String(st._id) === String(found.subtypeId));

  const dispatchedNet = dispatchedNetOf(found.batch);
  const remaining = remainingOf(found.batch, dispatchedNet);
  const orderMap = await hydrateOrders(linkedOrderIdSet(found.batch));
  const changes = mergeStockChanges(found.batch).map((c) => ({
    ...c,
    orderNumber: c.orderId ? orderMap.get(c.orderId)?.orderId ?? null : null,
    farmerName: c.orderId ? orderMap.get(c.orderId)?.farmerName || "" : "",
  }));
  const raw = {
    ...found.batch,
    slotId: found.slot._id,
    plantId: found.plantId,
    subtypeId: found.subtypeId,
    startDay: found.slot.startDay,
    endDay: found.slot.endDay,
    dispatchedNet,
    changeCount: changes.length,
  };

  return {
    ...toListRow(raw, plant, subtype, orderMap),
    changes,
    remaining,
    mortality: found.batch.noMortalityReserve ? 0 : n(found.batch.expectedMortalityApplied),
  };
}
