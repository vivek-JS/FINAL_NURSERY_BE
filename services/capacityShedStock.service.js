import mongoose from "mongoose";
import moment from "moment";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import PlantCms from "../models/plantCms.model.js";
import Order from "../models/order.model.js";
import { safeNonNegativeInt } from "../utility/safeMongooseNumber.js";

const UNASSIGNED = "Unassigned";

const shedName = (value) => String(value ?? "").trim() || UNASSIGNED;
const qty = (value) => safeNonNegativeInt(value, 0);
const idStr = (value) => (value == null ? "" : String(value));

/**
 * Remaining plants on one secondary-inward (lagwad) line.
 * availableQuantity is the source of truth; fall back safely for legacy rows.
 */
function remainingOnLine(si) {
  const total = qty(si?.totalQuantity);
  if (si?.availableQuantity != null) return Math.min(total, qty(si.availableQuantity));
  return si?.transferStatus === "fully_transferred" ? 0 : total;
}

function lineReadiness(si, secondaryDays, today) {
  if (si?.readinessBypassAt) return { ready: true, readyDate: si.readinessBypassAt };
  let readyDate = si?.expectedReadyDate || null;
  if (!readyDate && si?.secondaryInwardDate) {
    readyDate = moment(si.secondaryInwardDate).add(secondaryDays, "days").toDate();
  }
  const ready = readyDate ? moment(readyDate).startOf("day").isSameOrBefore(today) : false;
  return { ready, readyDate };
}

/**
 * Shed-wise secondary (lagwad) stock rolled up shed -> batch.
 *
 * Per batch inside a shed:
 *   sowed      plants lagwad-ed into the shed        (sum of secondaryInward.totalQuantity)
 *   remaining  plants still in the shed              (sum of secondaryInward.availableQuantity)
 *   gone       sowed - remaining
 *   toOrders   plants that left against an order     (secondaryOutward.linkedOrderId)
 *   orders     per-order breakdown of toOrders
 */
export async function loadShedStockPayload() {
  const today = moment().startOf("day");

  const batches = await DispatchBatch.find({ isActive: { $ne: false } })
    .select("batchNumber plantCmsId plantSubtypeId secondaryPlantReadyDays")
    .lean();
  if (!batches.length) return emptyPayload();

  const batchById = new Map(batches.map((b) => [idStr(b._id), b]));

  const plantIds = [...new Set(batches.map((b) => idStr(b.plantCmsId)).filter(Boolean))];
  const plantDocs = plantIds.length
    ? await PlantCms.find({ _id: { $in: plantIds } })
        .select("name subtypes._id subtypes.name")
        .lean()
    : [];
  const plantById = new Map(plantDocs.map((p) => [idStr(p._id), p]));

  const outwards = await PlantOutward.find({ batchId: { $in: batches.map((b) => b._id) } })
    .select("batchId secondaryInward secondaryOutward")
    .lean();

  // shed -> batch -> aggregate
  const sheds = new Map();
  const inwardShed = new Map(); // secondaryInwardId -> shed (to place outwards precisely)
  const orderIds = new Set();

  const batchBucket = (shed, batchId) => {
    if (!sheds.has(shed)) sheds.set(shed, new Map());
    const byBatch = sheds.get(shed);
    if (!byBatch.has(batchId)) {
      const batch = batchById.get(batchId);
      const plant = plantById.get(idStr(batch?.plantCmsId));
      const subtype = (plant?.subtypes || []).find(
        (st) => idStr(st._id) === idStr(batch?.plantSubtypeId)
      );
      byBatch.set(batchId, {
        batchId,
        batchNumber: batch?.batchNumber || "",
        plantName: plant?.name || "",
        subtypeName: subtype?.name || "",
        sowed: 0,
        remaining: 0,
        readyRemaining: 0,
        toOrders: 0,
        lines: [],
        orderMap: new Map(),
      });
    }
    return byBatch.get(batchId);
  };

  for (const po of outwards) {
    const batchId = idStr(po.batchId);
    const batch = batchById.get(batchId);
    if (!batch) continue;
    const secondaryDays = Number(batch.secondaryPlantReadyDays) || 0;

    for (const si of po.secondaryInward || []) {
      const sowed = qty(si.totalQuantity);
      if (sowed < 1) continue;
      const shed = shedName(si.pollyhouse);
      const remaining = remainingOnLine(si);
      const { ready, readyDate } = lineReadiness(si, secondaryDays, today);
      const bucket = batchBucket(shed, batchId);

      inwardShed.set(idStr(si._id), shed);
      bucket.sowed += sowed;
      bucket.remaining += remaining;
      if (ready) bucket.readyRemaining += remaining;
      bucket.lines.push({
        inwardId: idStr(si._id),
        size: si.size || "",
        cavity: Number(si.cavity) || 0,
        lagwadDate: si.secondaryInwardDate || null,
        readyDate: readyDate || null,
        ready,
        sowed,
        remaining,
        gone: Math.max(0, sowed - remaining),
        transferStatus: si.transferStatus || "available",
      });
    }

    for (const so of po.secondaryOutward || []) {
      if (so.stockSource === "SOW_READY") continue; // came from slot stock, not a shed
      const plants = qty(so.totalQuantity);
      if (plants < 1 || !so.linkedOrderId) continue;
      const shed =
        inwardShed.get(idStr(so.sourceSecondaryInwardId)) || shedName(so.pollyhouse);
      const bucket = batchBucket(shed, batchId);
      const orderId = idStr(so.linkedOrderId);
      orderIds.add(orderId);
      bucket.toOrders += plants;
      const prev = bucket.orderMap.get(orderId) || {
        orderId,
        plants: 0,
        lastAt: null,
        dispatchId: so.linkedDispatchId ? idStr(so.linkedDispatchId) : null,
      };
      prev.plants += plants;
      const at = so.secondaryOutwardDate || null;
      if (at && (!prev.lastAt || new Date(at) > new Date(prev.lastAt))) prev.lastAt = at;
      bucket.orderMap.set(orderId, prev);
    }
  }

  const orderDocs = orderIds.size
    ? await Order.find({
        _id: { $in: [...orderIds].filter((id) => mongoose.isValidObjectId(id)) },
      })
        .select("orderId farmer")
        .populate("farmer", "name mobileNumber")
        .lean()
    : [];
  const orderById = new Map(orderDocs.map((o) => [idStr(o._id), o]));

  const shedRows = [...sheds.entries()].map(([shed, byBatch]) => {
    const batchRows = [...byBatch.values()].map((b) => {
      const gone = Math.max(0, b.sowed - b.remaining);
      const orders = [...b.orderMap.values()]
        .map((entry) => {
          const order = orderById.get(entry.orderId);
          return {
            orderId: entry.orderId,
            orderNumber: order?.orderId || "",
            farmerName: order?.farmer?.name || "",
            farmerMobile: order?.farmer?.mobileNumber || "",
            plants: entry.plants,
            lastAt: entry.lastAt,
          };
        })
        .sort((a, c) => new Date(c.lastAt || 0) - new Date(a.lastAt || 0));
      return {
        batchId: b.batchId,
        batchNumber: b.batchNumber,
        plantName: b.plantName,
        subtypeName: b.subtypeName,
        sowed: b.sowed,
        remaining: b.remaining,
        readyRemaining: b.readyRemaining,
        gone,
        toOrders: Math.min(b.toOrders, gone || b.toOrders),
        otherGone: Math.max(0, gone - b.toOrders),
        lines: b.lines.sort((a, c) => new Date(a.lagwadDate || 0) - new Date(c.lagwadDate || 0)),
        orders,
      };
    });
    batchRows.sort(
      (a, c) => c.remaining - a.remaining || c.sowed - a.sowed || a.batchNumber.localeCompare(c.batchNumber)
    );
    const sum = (key) => batchRows.reduce((acc, row) => acc + row[key], 0);
    return {
      shed,
      batchCount: batchRows.length,
      activeBatchCount: batchRows.filter((row) => row.remaining > 0).length,
      sowed: sum("sowed"),
      remaining: sum("remaining"),
      readyRemaining: sum("readyRemaining"),
      gone: sum("gone"),
      toOrders: sum("toOrders"),
      otherGone: sum("otherGone"),
      batches: batchRows,
    };
  });

  shedRows.sort((a, c) => c.remaining - a.remaining || c.sowed - a.sowed || a.shed.localeCompare(c.shed));

  return {
    totals: {
      sheds: shedRows.length,
      batches: shedRows.reduce((acc, row) => acc + row.batchCount, 0),
      sowed: shedRows.reduce((acc, row) => acc + row.sowed, 0),
      remaining: shedRows.reduce((acc, row) => acc + row.remaining, 0),
      readyRemaining: shedRows.reduce((acc, row) => acc + row.readyRemaining, 0),
      gone: shedRows.reduce((acc, row) => acc + row.gone, 0),
      toOrders: shedRows.reduce((acc, row) => acc + row.toOrders, 0),
    },
    sheds: shedRows,
  };
}

function emptyPayload() {
  return {
    totals: { sheds: 0, batches: 0, sowed: 0, remaining: 0, readyRemaining: 0, gone: 0, toOrders: 0 },
    sheds: [],
  };
}
