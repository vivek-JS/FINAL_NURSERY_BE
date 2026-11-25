import mongoose from "mongoose";
import moment from "moment";
import Order from "../../models/order.model.js";
import PlantCms from "../../models/plantCms.model.js";
import SowingEntry from "../../models/sowingEntry.model.js";
import { IST_OFFSET, deliveryDateToIstMoment } from "../../utility/istSlotDate.js";
import { orderCoverSowings, sowingEntryRemaining } from "../../utility/safeZone.js";
import { allocateVirtualCover, applyVirtualOut, coverYmd } from "../../utility/virtualCover.js";

const DEFAULT_VIRTUAL_OUT_SINCE = "2026-11-25T00:00:00+05:30";

const SOWING_SELECT =
  "sourceBatchId plantId subtypeId requestNumber sowDay sowingDate sowingName plantReadyDate shedName plantsSowed destroyedPlants dispatchedPlants bufferPlants sowingBufferPct mortalityMovedToExcess excessMovedToMortality noMortalityReserve isIrrelevant";

const ORDER_SELECT =
  "orderId numberOfPlants additionalPlants orderBookingDate createdAt deliveryDate updatedAt orderStatus quotaSource sowingCoverSources sowingCoverReversedAt sowingPartialCover plantName plantSubtype farmer";

const OPEN_ORDER_STATUSES = [
  "ACCEPTED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_DISPATCHED",
];

function intQty(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function oid(value) {
  return value && mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;
}

export function virtualOutSinceDate() {
  const raw = process.env.VIRTUAL_OUT_SINCE || DEFAULT_VIRTUAL_OUT_SINCE;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date(DEFAULT_VIRTUAL_OUT_SINCE) : parsed;
}

function toOrderInput(order) {
  const plants = intQty(order.numberOfPlants) + intQty(order.additionalPlants);
  if (plants < 1) return null;
  const deliveryDate = deliveryDateToIstMoment(order.deliveryDate)?.format("YYYY-MM-DD") || "";
  const bookingDate = deliveryDateToIstMoment(order.orderBookingDate || order.createdAt)?.format("YYYY-MM-DD") || "";
  return {
    orderId: String(order._id),
    orderNumber: order.orderId ?? "",
    farmerName: order.farmer?.name || "",
    deliveryDate,
    bookingDate,
    plants,
    covers: orderCoverSowings(order),
  };
}

function toSowingInput(doc) {
  const remaining = sowingEntryRemaining(doc);
  return {
    entryId: String(doc._id),
    batchId: String(doc.sourceBatchId || ""),
    requestNumber: doc.requestNumber || "",
    sowingDate: coverYmd(doc.sowDay || doc.sowingDate),
    plantReadyDate: coverYmd(doc.plantReadyDate),
    shedName: doc.shedName || "",
    sowingName: String(doc.sowingName || "").trim(),
    remaining,
  };
}

/** Dispatched orders from the virtual-out cutoff onward, grouped by plantId|subtypeId. */
export async function dispatchedOrdersByVariety(plantIds, subtypeId = null, sinceDate = virtualOutSinceDate()) {
  if (!plantIds?.length) return new Map();
  const subtypeFilter = oid(subtypeId);
  const docs = await Order.find({
    plantName: { $in: plantIds },
    ...(subtypeFilter ? { plantSubtype: subtypeFilter } : {}),
    orderStatus: "DISPATCHED",
    updatedAt: { $gte: sinceDate },
    $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }, { quotaSource: null }],
  })
    .select(ORDER_SELECT)
    .populate("farmer", "name")
    .lean();

  const grouped = new Map();
  for (const doc of docs) {
    const item = toOrderInput(doc);
    if (!item) continue;
    const key = `${doc.plantName}|${doc.plantSubtype}`;
    const list = grouped.get(key) || [];
    list.push(item);
    grouped.set(key, list);
  }
  return grouped;
}

/** Run Step 1 (Virtual Out) -> Step 2 (Virtual Cover) for one variety. */
export function computeVirtualForVariety(sowingRows, dispatchedOrders, openOrders, options = {}) {
  const afterOut = applyVirtualOut(dispatchedOrders || [], sowingRows || []);
  const allocated = allocateVirtualCover(openOrders || [], afterOut.sowings, options);
  return { afterOut, allocated };
}

/**
 * Compute virtualOut, virtualRemaining, virtualCover, virtualExcess, and order lists
 * for a set of SowingEntry rows (used by /sowing/entries).
 */
export async function virtualMetricsForEntries(entries) {
  const active = (entries || []).filter((row) => !row?.isIrrelevant && row?.plantId && row?.subtypeId);
  if (!active.length) return new Map();

  const pairKeys = new Set();
  const plantIds = new Set();
  const subtypeIds = new Set();
  for (const row of active) {
    const p = String(row.plantId);
    const s = String(row.subtypeId);
    if (!mongoose.Types.ObjectId.isValid(p) || !mongoose.Types.ObjectId.isValid(s)) continue;
    pairKeys.add(`${p}|${s}`);
    plantIds.add(p);
    subtypeIds.add(s);
  }
  if (!pairKeys.size) return new Map();

  const plantOids = [...plantIds].map((id) => new mongoose.Types.ObjectId(id));
  const subtypeOids = [...subtypeIds].map((id) => new mongoose.Types.ObjectId(id));
  const sinceDate = virtualOutSinceDate();

  const [sowingDocs, openDocs, dispatchedDocs, plantDocs] = await Promise.all([
    SowingEntry.find({
      plantId: { $in: plantOids },
      subtypeId: { $in: subtypeOids },
      isIrrelevant: { $ne: true },
    })
      .select(SOWING_SELECT)
      .lean(),
    Order.find({
      plantName: { $in: plantOids },
      plantSubtype: { $in: subtypeOids },
      orderStatus: { $in: OPEN_ORDER_STATUSES },
      $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }, { quotaSource: null }],
    })
      .select(ORDER_SELECT)
      .populate("farmer", "name")
      .lean(),
    Order.find({
      plantName: { $in: plantOids },
      plantSubtype: { $in: subtypeOids },
      orderStatus: "DISPATCHED",
      updatedAt: { $gte: sinceDate },
      $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }, { quotaSource: null }],
    })
      .select(ORDER_SELECT)
      .populate("farmer", "name")
      .lean(),
    PlantCms.find({ _id: { $in: plantOids } })
      .select("subtypes._id subtypes.plantReadyDays")
      .lean(),
  ]);

  const readyDaysByKey = new Map();
  for (const plant of plantDocs) {
    for (const st of plant.subtypes || []) {
      readyDaysByKey.set(`${plant._id}|${st._id}`, intQty(st.plantReadyDays));
    }
  }
  const today = moment().utcOffset(IST_OFFSET).format("YYYY-MM-DD");

  const sowingsByKey = new Map();
  for (const doc of sowingDocs) {
    const key = `${doc.plantId}|${doc.subtypeId}`;
    if (!pairKeys.has(key)) continue;
    const list = sowingsByKey.get(key) || [];
    list.push(toSowingInput(doc));
    sowingsByKey.set(key, list);
  }

  const openByKey = new Map();
  for (const doc of openDocs) {
    const key = `${doc.plantName}|${doc.plantSubtype}`;
    if (!pairKeys.has(key)) continue;
    const item = toOrderInput(doc);
    if (!item) continue;
    const list = openByKey.get(key) || [];
    list.push(item);
    openByKey.set(key, list);
  }

  const dispatchedByKey = new Map();
  for (const doc of dispatchedDocs) {
    const key = `${doc.plantName}|${doc.plantSubtype}`;
    if (!pairKeys.has(key)) continue;
    const item = toOrderInput(doc);
    if (!item) continue;
    const list = dispatchedByKey.get(key) || [];
    list.push(item);
    dispatchedByKey.set(key, list);
  }

  const byEntryId = new Map();
  for (const key of pairKeys) {
    const { allocated } = computeVirtualForVariety(
      sowingsByKey.get(key) || [],
      dispatchedByKey.get(key) || [],
      openByKey.get(key) || [],
      { today, plantReadyDays: readyDaysByKey.get(key) || 0 }
    );
    for (const row of allocated.perSowing || []) {
      if (!row.entryId) continue;
      byEntryId.set(row.entryId, {
        virtualOut: row.virtualOut,
        virtualRemaining: row.virtualRemaining,
        virtualCover: row.virtualCover,
        virtualExcess: row.virtualExcess,
        virtualOutOrders: row.virtualOutOrders,
        virtualCoverOrders: row.virtualCoverOrders,
      });
    }
  }
  return byEntryId;
}
