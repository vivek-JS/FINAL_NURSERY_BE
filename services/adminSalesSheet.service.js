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
import { orderStatusExcludeMatch } from "../utility/istOrderDateStats.js";
import { transitionDrawerFacetStages } from "../utility/misTransitionMetrics.js";
import {
  orderIdsWithDispatchedAndCompletedSameDay,
} from "../utility/adminMisMetrics.js";
import { distinctOrderIdsWithTransitionEvents } from "../utility/misTransitionFromEvents.js";
import {
  enrichMisOrderList,
  hydrateMisOrderDrawerList,
} from "../utility/misOrderEnrichment.js";
import {
  resolveDateWindow,
  buildMisOrdersMatch,
} from "./adminMisOrders.service.js";
import {
  buildSalesSheetRows,
  SALES_SHEET_COLUMNS,
} from "../utility/adminSalesSheetRow.js";

/** Hard cap so a huge range cannot exhaust memory. */
const MAX_SALES_SHEET_ROWS = 10000;

const SALES_SHEET_PROJECT = {
  orderId: 1,
  orderStatus: 1,
  orderBookingDate: 1,
  deliveryDate: 1,
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

/** Orders that also reached COMPLETED in range belong to the Completed bucket, not Out. */
async function dispatchedExcludeIds(query, window, base) {
  const { rangeStart, rangeEnd } = window;
  const day = String(query?.date || "").slice(0, 10);
  const singleDay = day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day !== "past-due";
  if (singleDay) {
    const rawIds = await orderIdsWithDispatchedAndCompletedSameDay(
      rangeStart,
      rangeEnd,
      base
    );
    return rawIds.map((id) => toMongoIdIfValid(id)).filter(Boolean);
  }
  const rawIds = await distinctOrderIdsWithTransitionEvents(
    "COMPLETED",
    rangeStart,
    rangeEnd
  );
  return rawIds.filter(Boolean);
}

async function fetchDispatchedOrders(matchSpec, window, query) {
  const { rangeStart, rangeEnd } = window;
  const { newStatus, base, extra } = matchSpec;

  const excludeOrderIds = await dispatchedExcludeIds(query, window, base);
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

/** Batch-resolve Media (tray) + Reference (user) labels not covered by drawer hydration. */
async function buildSalesSheetLookups(orders) {
  const trayIds = uniqObjectIds(orders.map((o) => o.cavity));
  const referenceIds = uniqObjectIds(orders.map((o) => o.reference));

  const [trays, refUsers] = await Promise.all([
    trayIds.length
      ? Tray.find({ _id: { $in: trayIds } }).select("name").lean()
      : [],
    referenceIds.length
      ? User.find({ _id: { $in: referenceIds } }).select("name").lean()
      : [],
  ]);

  return {
    trayById: new Map(trays.map((t) => [String(t._id), t])),
    referenceById: new Map(refUsers.map((u) => [String(u._id), u])),
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

  return {
    data: {
      columns: SALES_SHEET_COLUMNS,
      rows,
      total: rows.length,
      capped: rows.length >= MAX_SALES_SHEET_ROWS,
      startDate: window.startYmd,
      endDate: window.endYmd,
    },
  };
}
