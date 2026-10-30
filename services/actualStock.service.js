import mongoose from "mongoose";
import moment from "moment";
import Order from "../models/order.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import { AS_ON as BANANA_AS_ON, PAPER as BANANA_PAPER } from "../scripts/data/paper-stock-2026-10-04.mjs";
import {
  ACTUAL_DISPATCH_STATUSES,
  actualDispatchLegs,
  buildStockLedger,
  currentStock,
  istDayKey,
} from "../utility/actualStock.js";
import { IST_OFFSET } from "../utility/istSlotDate.js";
import { createShortTtlCache } from "../utility/shortTtlCache.js";
import { resolveCropContext } from "./dispatchLagwadSources.js";

/**
 * Physical stock counts (notebook). `group` maps a subtype name / paper batch name to the same key,
 * so a variety only gets its own lines of the count.
 */
const STOCK_COUNTS = [
  {
    plant: /^banana$/i,
    asOn: BANANA_AS_ON,
    lines: BANANA_PAPER.flatMap((page) => page.lines.map((line) => ({ ...line, shed: page.shed }))),
    subtypeGroup: (name) => (/vasai/i.test(name || "") ? "vasai" : "main"),
    lineGroup: (line) => (/^VS/i.test(line.batch) ? "vasai" : "main"),
  },
];

const cache = createShortTtlCache(60_000);
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const n = (v) => Math.max(0, Math.floor(Number(v) || 0));

function loadOrders(plantId, subtypeId, after) {
  const filter = {
    plantName: oid(plantId),
    orderStatus: { $in: ACTUAL_DISPATCH_STATUSES },
    $or: [
      { "dispatchHistory.date": { $gte: after } },
      { statusChanges: { $elemMatch: { createdAt: { $gte: after }, newStatus: { $in: ACTUAL_DISPATCH_STATUSES } } } },
    ],
  };
  if (subtypeId) filter.plantSubtype = oid(subtypeId);
  return Order.find(filter)
    .select("-_id orderId orderStatus numberOfPlants additionalPlants dispatchHistory.date dispatchHistory.quantity dispatchHistory.source statusChanges.createdAt statusChanges.newStatus")
    .lean();
}

/** Lagwad entries made after the count day (returns excluded), newest first. */
async function loadLagwadAfter(plantId, subtypeId, after) {
  const batchFilter = { plantCmsId: oid(plantId) };
  if (subtypeId) batchFilter.plantSubtypeId = oid(subtypeId);
  const batches = await DispatchBatch.find(batchFilter).select("batchNumber").lean();
  if (!batches.length) return [];
  const batchNo = new Map(batches.map((b) => [String(b._id), b.batchNumber || ""]));
  const rows = await PlantOutward.aggregate([
    { $match: { batchId: { $in: batches.map((b) => b._id) }, "secondaryInward.secondaryInwardDate": { $gte: after } } },
    { $unwind: "$secondaryInward" },
    { $match: { "secondaryInward.secondaryInwardDate": { $gte: after }, "secondaryInward.isReturn": { $ne: true } } },
    {
      $project: {
        _id: 0,
        id: "$secondaryInward._id",
        batchId: 1,
        date: "$secondaryInward.secondaryInwardDate",
        shed: "$secondaryInward.pollyhouse",
        total: "$secondaryInward.totalQuantity",
        available: "$secondaryInward.availableQuantity",
        readyDate: "$secondaryInward.expectedReadyDate",
      },
    },
    { $sort: { date: -1 } },
  ]);
  return rows.map((r) => ({
    id: String(r.id),
    date: r.date,
    day: istDayKey(r.date),
    shed: r.shed || "",
    batchNumber: batchNo.get(String(r.batchId)) || "",
    total: n(r.total),
    available: Math.min(n(r.available), n(r.total)),
    readyDate: r.readyDate || null,
  }));
}

/** Actual stock for a crop/variety with a physical count, else null. */
export async function getActualStock({ plantId, subtypeId }) {
  const key = `${plantId}|${subtypeId || ""}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const context = await resolveCropContext(plantId, subtypeId);
  const count = STOCK_COUNTS.find((c) => c.plant.test(context.plantName));
  if (!count) return null;
  if (subtypeId && !context.subtypeName) return null;

  const group = subtypeId ? count.subtypeGroup(context.subtypeName) : null;
  const opening = count.lines.filter((l) => !group || count.lineGroup(l) === group).reduce((s, l) => s + n(l.qty), 0);
  const after = moment(count.asOn, "YYYY-MM-DD").utcOffset(IST_OFFSET, true).startOf("day").add(1, "day").toDate();

  const [orders, entries] = await Promise.all([loadOrders(plantId, subtypeId, after), loadLagwadAfter(plantId, subtypeId, after)]);
  const dispatch = [];
  let dispatchOrders = 0;
  for (const order of orders) {
    const legs = actualDispatchLegs(order, after);
    if (!legs.length) continue;
    dispatchOrders += 1;
    for (const leg of legs) dispatch.push({ ...leg, orderId: order.orderId, status: order.orderStatus });
  }
  const dispatchAfter = dispatch.reduce((s, d) => s + d.qty, 0);
  const lagwadAfter = entries.reduce((s, e) => s + e.total, 0);

  const body = {
    asOn: count.asOn,
    opening,
    lagwadAfter,
    dispatchAfter,
    dispatchOrders,
    current: currentStock({ opening, lagwadAfter, dispatchAfter }),
    ledger: buildStockLedger({
      asOn: count.asOn,
      opening,
      lagwad: entries.map((e) => ({ day: e.day, qty: e.total })),
      dispatch,
    }),
    entries,
  };
  cache.set(key, body);
  return body;
}
