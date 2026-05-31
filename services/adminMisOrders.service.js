import mongoose from "mongoose";
import Order from "../models/order.model.js";
import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
  istDayBoundsFromYmd,
} from "../utility/istOrderDateStats.js";
import { parseCentralReportDateRange } from "../utility/centralReportEngine/dateRange.js";
import { duePipelineMatch } from "../utility/adminMisDue.js";
import { matchDeliveryDateInRange } from "../utility/centralReportEngine/deliveryMatch.js";
import { transitionDrawerFacetStages } from "../utility/misTransitionMetrics.js";
import {
  orderIdsWithDispatchedAndCompletedSameDay,
} from "../utility/adminMisMetrics.js";
import { distinctOrderIdsWithTransitionEvents } from "../utility/misTransitionFromEvents.js";
import {
  enrichMisOrderList,
  hydrateMisOrderDrawerList,
} from "../utility/misOrderEnrichment.js";

const IST = "Asia/Kolkata";

const PIPELINE_OTHER_STATUSES = ["PENDING", "PROCESSING", "ASSIGNED"];

const ORDER_LIST_PROJECT = {
  orderId: 1,
  orderStatus: 1,
  orderBookingDate: 1,
  deliveryDate: 1,
  numberOfPlants: 1,
  additionalPlants: 1,
  plantName: 1,
  plantSubtype: 1,
  farmer: 1,
  salesPerson: 1,
  dealer: 1,
  dealerOrder: 1,
  statusChanges: 1,
  dispatchHistory: 1,
  orderFor: 1,
};

function parsePageLimit(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

function resolveDateWindow(query) {
  const day = String(query.date || "").slice(0, 10);
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day !== "past-due") {
    const { start, end } = istDayBoundsFromYmd(day);
    return { startYmd: day, endYmd: day, rangeStart: start, rangeEnd: end };
  }
  const parsed = parseCentralReportDateRange(
    query.startDate || query.rangeStart,
    query.endDate || query.rangeEnd
  );
  if (parsed.error) return { error: parsed.error };
  return {
    startYmd: parsed.startYmd,
    endYmd: parsed.endYmd,
    rangeStart: parsed.rangeStart,
    rangeEnd: parsed.rangeEnd,
  };
}

function deliveryInRangeClause(rangeStart, rangeEnd) {
  return { deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null } };
}

/** Delivery total — delivery in range but not DISPATCHED or COMPLETED. */
function deliveryTotalInRangeClause(rangeStart, rangeEnd) {
  return matchDeliveryDateInRange(rangeStart, rangeEnd);
}

function bookingInRangeClause(rangeStart, rangeEnd) {
  return { orderBookingDate: { $gte: rangeStart, $lte: rangeEnd } };
}

/** Aggregation $match needs ObjectId — string ids do not match (unlike find/count). */
function toMongoIdIfValid(value) {
  if (value == null || value === "") return undefined;
  const s = String(value).trim();
  if (!mongoose.Types.ObjectId.isValid(s)) return value;
  return new mongoose.Types.ObjectId(s);
}

/**
 * Build Mongo match for MIS drawer — mirrors adminMisMetrics column rules.
 */
export function buildMisOrdersMatch(query, window) {
  const { rangeStart, rangeEnd } = window;
  const base = orderStatusExcludeMatch();
  const bucket = String(query.bucket || "").trim();
  const mode = String(query.mode || "delivery").trim();
  const pastDueOnly = String(query.pastDueOnly ?? "") === "true";
  const dueOnly = String(query.dueOnly ?? "") === "true";
  const includeAllPastDue = String(query.includeAllPastDue ?? "") === "true";
  const drawerSegment = String(query.drawerSegment || "").trim();
  const hasSingleDay =
    query.date && String(query.date).slice(0, 10) !== "past-due";
  const isTotalsScope = !hasSingleDay;

  const extra = {};
  const salesPerson = toMongoIdIfValid(query.salesPerson || query.salesPersonId);
  const orderDealer = toMongoIdIfValid(query.orderDealer || query.dealerId);
  if (salesPerson) extra.salesPerson = salesPerson;
  if (orderDealer) {
    extra.dealer = orderDealer;
    extra.dealerOrder = true;
  }
  const plantId = toMongoIdIfValid(query.plantId);
  const subtypeId = toMongoIdIfValid(query.subtypeId);
  if (plantId) extra.plantName = plantId;
  if (subtypeId) extra.plantSubtype = subtypeId;

  if (bucket === "dispatched" || bucket === "completed") {
    return {
      kind: "transition",
      newStatus: bucket === "dispatched" ? "DISPATCHED" : "COMPLETED",
      base,
      extra,
    };
  }

  if (pastDueOnly) {
    return {
      ...base,
      ...extra,
      ...duePipelineMatch(),
      deliveryDate: { $lt: rangeStart, $ne: null },
    };
  }

  if (mode === "booking" || bucket === "booking") {
    return { ...base, ...extra, ...bookingInRangeClause(rangeStart, rangeEnd) };
  }

  const dueScope = dueOnly || String(query.scope || "") === "due";
  const dueFilter = dueScope ? duePipelineMatch() : {};
  const varietyScope =
    String(query.scope || "") === "variety" || (plantId && subtypeId);

  switch (bucket) {
    case "accepted":
      return {
        ...base,
        ...extra,
        ...dueFilter,
        orderStatus: "ACCEPTED",
        ...deliveryInRangeClause(rangeStart, rangeEnd),
      };
    case "farmReady":
      return { ...base, ...extra, ...dueFilter, orderStatus: "FARM_READY" };
    case "readyForDispatch":
      return { ...base, ...extra, ...dueFilter, orderStatus: "READY_FOR_DISPATCH" };
    case "dispatchProcess":
      return {
        ...base,
        ...extra,
        ...dueFilter,
        orderStatus: "DISPATCH_PROCESS",
        $or: [
          deliveryInRangeClause(rangeStart, rangeEnd),
          { updatedAt: { $gte: rangeStart, $lte: rangeEnd } },
        ],
      };
    case "partiallyCompleted":
      return {
        ...base,
        ...extra,
        ...dueFilter,
        orderStatus: "PARTIALLY_COMPLETED",
        $or: [
          deliveryInRangeClause(rangeStart, rangeEnd),
          { updatedAt: { $gte: rangeStart, $lte: rangeEnd } },
        ],
      };
    case "other":
      return {
        ...base,
        ...extra,
        ...dueFilter,
        orderStatus: { $in: PIPELINE_OTHER_STATUSES },
        ...deliveryInRangeClause(rangeStart, rangeEnd),
      };
    case "deliveryTotal": {
      if (varietyScope) {
        return {
          ...base,
          ...extra,
          ...dueFilter,
          ...deliveryTotalInRangeClause(rangeStart, rangeEnd),
        };
      }
      /** Drawer tab: in-range only (when All past due splits the list). */
      if (drawerSegment === "inRange") {
        return {
          ...base,
          ...extra,
          ...dueFilter,
          ...deliveryTotalInRangeClause(rangeStart, rangeEnd),
        };
      }
      if (includeAllPastDue && isTotalsScope) {
        return {
          ...base,
          ...extra,
          $or: [
            {
              ...(dueScope ? duePipelineMatch() : {}),
              ...deliveryTotalInRangeClause(rangeStart, rangeEnd),
            },
            {
              ...duePipelineMatch(),
              deliveryDate: { $lt: rangeStart, $ne: null },
            },
          ],
        };
      }
      if (dueScope) {
        return {
          ...base,
          ...extra,
          ...duePipelineMatch(),
          ...deliveryTotalInRangeClause(rangeStart, rangeEnd),
        };
      }
      if (isTotalsScope) {
        return {
          ...base,
          ...extra,
          $or: [
            deliveryTotalInRangeClause(rangeStart, rangeEnd),
            { orderStatus: "FARM_READY" },
            { orderStatus: "READY_FOR_DISPATCH" },
          ],
        };
      }
      return { ...base, ...extra, ...deliveryTotalInRangeClause(rangeStart, rangeEnd) };
    }
    case "yetToDispatch": {
      const branches = [
        {
          orderStatus: "ACCEPTED",
          ...deliveryInRangeClause(rangeStart, rangeEnd),
        },
        { orderStatus: "FARM_READY" },
        { orderStatus: "READY_FOR_DISPATCH" },
        {
          orderStatus: "DISPATCH_PROCESS",
          ...deliveryInRangeClause(rangeStart, rangeEnd),
        },
        {
          orderStatus: "PARTIALLY_COMPLETED",
          ...deliveryInRangeClause(rangeStart, rangeEnd),
        },
        {
          orderStatus: { $in: PIPELINE_OTHER_STATUSES },
          ...deliveryInRangeClause(rangeStart, rangeEnd),
        },
      ];
      if (dueScope) {
        return {
          ...base,
          ...extra,
          $or: branches.map((branch) => ({ ...duePipelineMatch(), ...branch })),
        };
      }
      return { ...base, ...extra, $or: branches };
    }
    default:
      return {
        ...base,
        ...extra,
        ...dueFilter,
        ...deliveryInRangeClause(rangeStart, rangeEnd),
      };
  }
}

async function fetchTransitionOrders(matchSpec, window, query, { skip, limit }) {
  const { rangeStart, rangeEnd } = window;
  const { newStatus, base, extra } = matchSpec;

  let excludeOrderIds = [];
  if (newStatus === "DISPATCHED") {
    const day = String(query?.date || "").slice(0, 10);
    const singleDay = day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day !== "past-due";
    if (singleDay) {
      const rawIds = await orderIdsWithDispatchedAndCompletedSameDay(
        rangeStart,
        rangeEnd,
        base
      );
      excludeOrderIds = rawIds
        .map((id) => toMongoIdIfValid(id))
        .filter(Boolean);
    } else {
      const rawIds = await distinctOrderIdsWithTransitionEvents(
        "COMPLETED",
        rangeStart,
        rangeEnd
      );
      excludeOrderIds = rawIds.filter(Boolean);
    }
  }

  const idExclude =
    excludeOrderIds.length > 0 ? { _id: { $nin: excludeOrderIds } } : {};

  const pipeline = [
    { $match: { ...base, ...extra, ...idExclude } },
    ...transitionDrawerFacetStages(newStatus, rangeStart, rangeEnd),
    { $sort: { bucketEventAt: -1 } },
    {
      $facet: {
        metadata: [{ $count: "total" }],
        data: [
          { $skip: skip },
          { $limit: limit },
          {
            $lookup: {
              from: "orders",
              localField: "_id",
              foreignField: "_id",
              as: "doc",
              pipeline: [{ $project: ORDER_LIST_PROJECT }],
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
        ],
      },
    },
  ];

  const [result] = await Order.aggregate(pipeline);
  const total = result?.metadata?.[0]?.total ?? 0;
  const data = result?.data ?? [];
  return { data, total };
}

async function fetchStandardOrders(match, { skip, limit }) {
  const [data, total] = await Promise.all([
    Order.find(match)
      .select(ORDER_LIST_PROJECT)
      .sort({ deliveryDate: -1, orderBookingDate: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Order.countDocuments(match),
  ]);
  return { data, total };
}

/**
 * Paginated orders for MIS drawer — same rules as MIS count aggregations.
 */
export async function fetchAdminMisOrders(query = {}) {
  const window = resolveDateWindow(query);
  if (window.error) {
    return { error: window.error, statusCode: 400 };
  }

  const bucket = String(query.bucket || "").trim();
  if (!bucket || bucket === "unique") {
    return { error: "bucket is required (except unique)", statusCode: 400 };
  }

  const { page, limit, skip } = parsePageLimit(query);
  const matchSpec = buildMisOrdersMatch(query, window);

  let data;
  let total;

  if (matchSpec?.kind === "transition") {
    const result = await fetchTransitionOrders(matchSpec, window, query, { skip, limit });
    data = await hydrateMisOrderDrawerList(enrichMisOrderList(result.data, bucket));
    total = result.total;
  } else {
    const result = await fetchStandardOrders(matchSpec, { skip, limit });
    data = await hydrateMisOrderDrawerList(enrichMisOrderList(result.data, bucket));
    total = result.total;
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return {
    data: {
      data,
      total,
      currentPage: page,
      totalPages,
      limit,
      bucket,
      startDate: window.startYmd,
      endDate: window.endYmd,
    },
  };
}
