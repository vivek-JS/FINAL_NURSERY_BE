/**
 * Admin MIS "Sales Sheet" export.
 *
 * Returns every dispatched ("Out") order for a date range as flat sales-register
 * rows. Mirrors the dispatched-bucket rules used by the MIS drawer
 * (see adminMisOrders.service.js) but fetches all rows (capped) with an
 * extended projection and resolves Media (tray) + Reference (user) labels.
 */

import mongoose from "mongoose";
import Order from "../models/order.model.js";
import Tray from "../models/tray.model.js";
import User from "../models/user.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import { orderStatusExcludeMatch } from "../utility/istOrderDateStats.js";
import { transitionDrawerFacetStages } from "../utility/misTransitionMetrics.js";
import {
  enrichMisOrderList,
  hydrateMisOrderDrawerList,
  pickDispatchLegForBucket,
} from "../utility/misOrderEnrichment.js";
import {
  resolveDateWindow,
  buildMisOrdersMatch,
  resolveDispatchedExcludeOrderIds,
} from "./adminMisOrders.service.js";
import {
  buildSalesSheetRows,
  buildSalesSheetTotalsRow,
  SALES_SHEET_COLUMNS,
} from "../utility/adminSalesSheetRow.js";

/** Hard cap so a huge range cannot exhaust memory. */
const MAX_SALES_SHEET_ROWS = 10000;

const SALES_SHEET_PROJECT = {
  orderId: 1,
  orderStatus: 1,
  orderBookingDate: 1,
  deliveryDate: 1,
  oldDeliveryDate: 1,
  numberOfPlants: 1,
  additionalPlants: 1,
  totalPlants: 1,
  returnedPlants: 1,
  damagedPlants: 1,
  plantName: 1,
  plantSubtype: 1,
  farmer: 1,
  salesPerson: 1,
  dealer: 1,
  dealerOrder: 1,
  statusChanges: 1,
  dispatchHistory: 1,
  assignedVehicle: 1,
  orderFor: 1,
  rate: 1,
  freightCharges: 1,
  batchNumber: 1,
  expectedNursery: 1,
  deliveryChallanInvoiceNumber: 1,
  officialDeliveryChallanNumber: 1,
  reference: 1,
  cavity: 1,
};

function toMongoIdIfValid(value) {
  if (value == null || value === "") return undefined;
  const s = String(value).trim();
  if (!mongoose.Types.ObjectId.isValid(s)) return undefined;
  return new mongoose.Types.ObjectId(s);
}

function uniqObjectIds(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const id = toMongoIdIfValid(v);
    if (!id) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

async function fetchDispatchedOrders(matchSpec, window, query) {
  const { rangeStart, rangeEnd } = window;
  const { newStatus, base, extra } = matchSpec;

  const excludeOrderIds = await resolveDispatchedExcludeOrderIds(
    query,
    window,
    base
  );
  const idExclude =
    excludeOrderIds.length > 0 ? { _id: { $nin: excludeOrderIds } } : {};

  const pipeline = [
    { $match: { ...base, ...extra, ...idExclude } },
    ...transitionDrawerFacetStages(newStatus, rangeStart, rangeEnd),
    { $sort: { bucketEventAt: -1 } },
    { $limit: MAX_SALES_SHEET_ROWS },
    {
      $lookup: {
        from: "orders",
        localField: "_id",
        foreignField: "_id",
        as: "doc",
        pipeline: [{ $project: SALES_SHEET_PROJECT }],
      },
    },
    { $unwind: "$doc" },
    {
      $replaceRoot: {
        newRoot: {
          $mergeObjects: ["$doc", { bucketEventAt: "$bucketEventAt" }],
        },
      },
    },
  ];

  return Order.aggregate(pipeline);
}

/** Batch-resolve Media (tray), Reference (user), and pipeline batch labels. */
async function buildSalesSheetLookups(orders) {
  const trayIds = uniqObjectIds(orders.map((o) => o.cavity));
  const referenceIds = uniqObjectIds(orders.map((o) => o.reference));
  const dispatchBatchIds = uniqObjectIds(
    orders.flatMap((o) => {
      const leg = pickDispatchLegForBucket(o, o.bucketEventAt);
      return leg?.dispatchBatchId ? [leg.dispatchBatchId] : [];
    })
  );

  const [trays, refUsers, dispatchBatches] = await Promise.all([
    trayIds.length
      ? Tray.find({ _id: { $in: trayIds } }).select("name").lean()
      : [],
    referenceIds.length
      ? User.find({ _id: { $in: referenceIds } }).select("name").lean()
      : [],
    dispatchBatchIds.length
      ? DispatchBatch.find({ _id: { $in: dispatchBatchIds } })
          .select("batchNumber")
          .lean()
      : [],
  ]);

  return {
    trayById: new Map(trays.map((t) => [String(t._id), t])),
    referenceById: new Map(refUsers.map((u) => [String(u._id), u])),
    dispatchBatchById: new Map(dispatchBatches.map((b) => [String(b._id), b])),
  };
}

/**
 * @param {object} query Express query (startDate, endDate)
 * @returns {Promise<{ data?: object, error?: string, statusCode?: number }>}
 */
export async function fetchAdminSalesSheet(query = {}) {
  const window = resolveDateWindow(query);
  if (window.error) {
    return { error: window.error, statusCode: 400 };
  }

  const matchSpec = buildMisOrdersMatch(
    { bucket: "dispatched", mode: "delivery" },
    window
  );

  // dispatched always resolves to a transition match; guard defensively.
  if (matchSpec?.kind !== "transition") {
    matchSpec.base = matchSpec.base || orderStatusExcludeMatch();
  }

  const rawOrders = await fetchDispatchedOrders(matchSpec, window, query);
  const enriched = await hydrateMisOrderDrawerList(
    enrichMisOrderList(rawOrders, "dispatched")
  );
  const lookups = await buildSalesSheetLookups(enriched);
  const rows = buildSalesSheetRows(enriched, lookups);
  const totalsRow = buildSalesSheetTotalsRow(rows);

  return {
    data: {
      columns: SALES_SHEET_COLUMNS,
      rows,
      totalsRow,
      total: rows.length,
      capped: rows.length >= MAX_SALES_SHEET_ROWS,
      startDate: window.startYmd,
      endDate: window.endYmd,
    },
  };
}
