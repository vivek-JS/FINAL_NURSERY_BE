import Order from "../models/order.model.js";
import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
  parseYmdRange,
  istDayBoundsFromYmd,
} from "../utility/istOrderDateStats.js";
import { DUE_DELIVERY_STATUSES } from "../utility/adminMisDue.js";
import { matchDeliveryDateInRange } from "../utility/adminMisMetrics.js";
import { enrichMisOrderList } from "../utility/misOrderEnrichment.js";

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
};

function parsePageLimit(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 15));
  return { page, limit, skip: (page - 1) * limit };
}

function resolveDateWindow(query) {
  const day = String(query.date || "").slice(0, 10);
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day !== "past-due") {
    const { start, end } = istDayBoundsFromYmd(day);
    return { startYmd: day, endYmd: day, rangeStart: start, rangeEnd: end };
  }
  const parsed = parseYmdRange(query.startDate || query.rangeStart, query.endDate || query.rangeEnd);
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

/** Delivery total — delivery in range but not DISPATCHED. */
function deliveryTotalInRangeClause(rangeStart, rangeEnd) {
  return matchDeliveryDateInRange(rangeStart, rangeEnd);
}

function bookingInRangeClause(rangeStart, rangeEnd) {
  return { orderBookingDate: { $gte: rangeStart, $lte: rangeEnd } };
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
  const hasSingleDay =
    query.date && String(query.date).slice(0, 10) !== "past-due";
  const isTotalsScope = !hasSingleDay;

  const extra = {};
  const salesPerson = query.salesPerson || query.salesPersonId;
  const orderDealer = query.orderDealer || query.dealerId;
  if (salesPerson) extra.salesPerson = salesPerson;
  if (orderDealer) {
    extra.dealer = orderDealer;
    extra.dealerOrder = true;
  }
  const plantId = query.plantId;
  const subtypeId = query.subtypeId;
  if (plantId) extra.plantName = plantId;
  if (subtypeId) extra.plantSubtype = subtypeId;

  if (pastDueOnly) {
    return {
      ...base,
      ...extra,
      orderStatus: { $in: DUE_DELIVERY_STATUSES },
      deliveryDate: { $lt: rangeStart, $ne: null },
    };
  }

  if (dueOnly || String(query.scope || "") === "due") {
    return {
      ...base,
      ...extra,
      orderStatus: { $in: DUE_DELIVERY_STATUSES },
      ...deliveryInRangeClause(rangeStart, rangeEnd),
    };
  }

  if (mode === "booking" || bucket === "booking") {
    return { ...base, ...extra, ...bookingInRangeClause(rangeStart, rangeEnd) };
  }

  switch (bucket) {
    case "accepted":
      return {
        ...base,
        ...extra,
        orderStatus: "ACCEPTED",
        ...deliveryInRangeClause(rangeStart, rangeEnd),
      };
    case "farmReady":
      return { ...base, ...extra, orderStatus: "FARM_READY" };
    case "readyForDispatch":
      return { ...base, ...extra, orderStatus: "READY_FOR_DISPATCH" };
    case "dispatchProcess":
      return {
        ...base,
        ...extra,
        orderStatus: "DISPATCH_PROCESS",
        ...deliveryInRangeClause(rangeStart, rangeEnd),
      };
    case "partiallyCompleted":
      return {
        ...base,
        ...extra,
        orderStatus: "PARTIALLY_COMPLETED",
        ...deliveryInRangeClause(rangeStart, rangeEnd),
      };
    case "other":
      return {
        ...base,
        ...extra,
        orderStatus: { $in: PIPELINE_OTHER_STATUSES },
        ...deliveryInRangeClause(rangeStart, rangeEnd),
      };
    case "deliveryTotal":
      if (
        String(query.scope || "") === "variety" ||
        (plantId && subtypeId)
      ) {
        return { ...base, ...extra, ...deliveryTotalInRangeClause(rangeStart, rangeEnd) };
      }
      if (includeAllPastDue && isTotalsScope) {
        return {
          ...base,
          ...extra,
          $or: [
            deliveryTotalInRangeClause(rangeStart, rangeEnd),
            {
              deliveryDate: { $lt: rangeStart, $ne: null },
              orderStatus: { $nin: ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED", "DISPATCHED"] },
            },
            { orderStatus: "FARM_READY" },
            { orderStatus: "READY_FOR_DISPATCH" },
          ],
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
    case "yetToDispatch":
      return {
        ...base,
        ...extra,
        $or: [
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
        ],
      };
    case "dispatched":
    case "completed":
      return { kind: "transition", newStatus: bucket === "dispatched" ? "DISPATCHED" : "COMPLETED", base, extra };
    default:
      return { ...base, ...extra, ...deliveryInRangeClause(rangeStart, rangeEnd) };
  }
}

async function fetchTransitionOrders(matchSpec, window, { skip, limit }) {
  const { rangeStart, rangeEnd } = window;
  const { newStatus, base, extra } = matchSpec;

  const pipeline = [
    { $match: { ...base, ...extra } },
    { $unwind: "$statusChanges" },
    {
      $match: {
        "statusChanges.newStatus": newStatus,
        "statusChanges.createdAt": { $gte: rangeStart, $lte: rangeEnd },
      },
    },
    {
      $group: {
        _id: "$_id",
        bucketEventAt: { $min: "$statusChanges.createdAt" },
      },
    },
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
    const result = await fetchTransitionOrders(matchSpec, window, { skip, limit });
    data = enrichMisOrderList(result.data, bucket);
    total = result.total;
  } else {
    const result = await fetchStandardOrders(matchSpec, { skip, limit });
    data = enrichMisOrderList(result.data, bucket);
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
