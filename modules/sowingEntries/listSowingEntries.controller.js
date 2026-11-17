import mongoose from "mongoose";
import Order from "../../models/order.model.js";
import SowingEntry from "../../models/sowingEntry.model.js";
import { attributedOrderPlants } from "./linkedOrdersForEntry.js";
import { toSowingEntryListItem } from "./mapSowingEntry.js";

function oid(value) {
  const text = String(value || "").trim();
  return mongoose.Types.ObjectId.isValid(text) ? new mongoose.Types.ObjectId(text) : null;
}

const SORT_KEYS = {
  plant: ["subtypeName", "plantName"],
  sowingId: ["requestNumber"],
  sowDate: ["sowDay", "requestNumber"],
  readyDate: ["readySort"],
  out: ["dispatchedPlants"],
  remaining: ["remainingSort"],
  sowed: ["plantsSowed"],
  expectedReady: ["expectedReady"],
  cover: ["coverSort"],
  excess: ["excessSort"],
  mortality: ["mortalitySort"],
};

/** Sort for the new sowing-entries table. Unknown keys stay newest sow first. */
export function sowingEntriesSortSpec(sort, dir) {
  const direction = String(dir || "").toLowerCase() === "asc" ? 1 : -1;
  const keys = SORT_KEYS[sort] || ["sowDay", "requestNumber"];
  const spec = {};
  for (const key of keys) spec[key] = direction;
  if (spec.sowDay == null) spec.sowDay = -1;
  if (spec.requestNumber == null) spec.requestNumber = -1;
  spec._id = -1;
  return spec;
}

function num(field) {
  return { $convert: { input: { $ifNull: [field, 0] }, to: "double", onError: 0, onNull: 0 } };
}

function daySort(field) {
  return {
    $let: {
      vars: { text: { $ifNull: [field, ""] } },
      in: {
        $switch: {
          branches: [
            {
              case: { $regexMatch: { input: "$$text", regex: "^\\d{4}-\\d{2}-\\d{2}" } },
              then: { $substrBytes: ["$$text", 0, 10] },
            },
            {
              case: { $regexMatch: { input: "$$text", regex: "^\\d{2}-\\d{2}-\\d{4}$" } },
              then: {
                $concat: [
                  { $substrBytes: ["$$text", 6, 4] },
                  "-",
                  { $substrBytes: ["$$text", 3, 2] },
                  "-",
                  { $substrBytes: ["$$text", 0, 2] },
                ],
              },
            },
          ],
          default: "",
        },
      },
    },
  };
}

/** Same mortality, ready, cover, and excess the table shows from the stored entry. */
export function sowingEntrySortFigures() {
  const netSowed = { $max: [0, { $subtract: [num("$plantsSowed"), num("$destroyedPlants")] }] };
  const buffer = {
    $cond: [
      { $gt: [num("$sowingBufferPct"), 0] },
      { $round: [{ $multiply: [netSowed, { $divide: [num("$sowingBufferPct"), 100] }] }, 0] },
      num("$bufferPlants"),
    ],
  };
  const mortality = {
    $cond: [
      { $eq: ["$noMortalityReserve", true] },
      0,
      { $max: [0, { $subtract: [buffer, num("$mortalityMovedToExcess")] }] },
    ],
  };
  const expectedReady = { $max: [0, { $subtract: [netSowed, mortality] }] };
  const remainingSort = { $max: [0, { $subtract: [expectedReady, num("$dispatchedPlants")] }] };
  const coverSort = { $min: [num("$orderCoveredPlants"), expectedReady] };
  const excessSort = {
    $max: [
      0,
      {
        $subtract: [
          {
          $add: [
            { $subtract: [netSowed, buffer] },
            { $add: [num("$mortalityMovedToExcess"), num("$plantsMarkedSellable")] },
          ],
        },
          { $add: [coverSort, num("$excessMovedToMortality")] },
        ],
      },
    ],
  };
  return {
    readySort: daySort("$plantReadyDate"),
    mortalitySort: mortality,
    expectedReady,
    remainingSort,
    coverSort,
    excessSort,
  };
}

function listFilter(query) {
  const filter = {};
  const plantId = oid(query.plantId);
  const subtypeId = oid(query.subtypeId);
  if (plantId) filter.plantId = plantId;
  if (subtypeId) filter.subtypeId = subtypeId;
  const requestNumber = String(query.requestNumber || query.q || "").trim();
  if (requestNumber) {
    filter.requestNumber = new RegExp(requestNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const from = String(query.sowFrom || query.from || "").trim();
  const to = String(query.sowTo || query.to || "").trim();
  if (from || to) {
    filter.sowDay = {};
    if (from) filter.sowDay.$gte = from;
    if (to) filter.sowDay.$lte = to;
  }
  return filter;
}

/** Parallel sowing-entries list. Old GET /sowing/completions?view=entries stays as it is. */
export async function getSowingEntriesCollection(req, res) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const filter = listFilter(req.query);
  const sort = sowingEntriesSortSpec(req.query.sort, req.query.dir);
  const [rows, total] = await Promise.all([
    SowingEntry.aggregate([
      { $match: filter },
      { $addFields: sowingEntrySortFigures() },
      { $sort: sort },
      { $skip: (page - 1) * limit },
      { $limit: limit },
    ]).collation({ locale: "en", strength: 2 }),
    SowingEntry.countDocuments(filter),
  ]);
  const orderIds = [
    ...new Set(rows.flatMap((row) => (row.linkedOrderIds || []).map((id) => String(id)))),
  ].filter((id) => mongoose.Types.ObjectId.isValid(id));
  const orders = orderIds.length
    ? await Order.find({ _id: { $in: orderIds.map((id) => new mongoose.Types.ObjectId(id)) } })
        .select("numberOfPlants additionalPlants sowingDoneRequestId sowingCoverSources sowingPartialCover")
        .lean()
    : [];
  return res.json({
    success: true,
    view: "entries",
    source: "sowingentries",
    items: rows.map((row) => toSowingEntryListItem(row, attributedOrderPlants(row, orders))),
    total,
    page,
    limit,
    pages: Math.ceil(total / limit) || 0,
  });
}
