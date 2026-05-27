import Order from "../models/order.model.js";
import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
  istDateStringExpr,
} from "../utility/istOrderDateStats.js";
import { parseCentralReportDateRange } from "../utility/centralReportEngine/dateRange.js";
import {
  aggregateDueSummary,
  aggregatePastDueDeliveryRows,
} from "../utility/adminMisDue.js";
import {
  fetchMisMetricSlices,
  buildAdminDailyMisPayloadFromMetrics,
  fetchVarietyTableMetrics,
} from "../utility/adminMisMetrics.js";

/** Resolve plant + subtype labels for variety aggregations. */
const PLANT_SUBTYPE_STAGES = [
  {
    $lookup: {
      from: "plantcms",
      localField: "plantName",
      foreignField: "_id",
      as: "_plantData",
      pipeline: [{ $project: { name: 1, subtypes: 1 } }],
    },
  },
  {
    $addFields: {
      _plantRow: { $arrayElemAt: ["$_plantData", 0] },
      _plantTypeName: { $arrayElemAt: ["$_plantData.name", 0] },
    },
  },
  {
    $addFields: {
      _matchedSubtype: {
        $arrayElemAt: [
          {
            $filter: {
              input: { $ifNull: ["$_plantRow.subtypes", []] },
              as: "st",
              cond: { $eq: ["$$st._id", "$plantSubtype"] },
            },
          },
          0,
        ],
      },
    },
  },
  {
    $addFields: {
      _subtypeName: { $ifNull: ["$_matchedSubtype.name", "Other"] },
    },
  },
];

export async function fetchAdminDailyMis(startDate, endDate, options = {}) {
  const { dueOnly = false, includeAllPastDue = false } = options;
  const parsed = parseCentralReportDateRange(startDate, endDate);
  if (parsed.error) {
    return { error: parsed.error, statusCode: 400 };
  }
  const { rangeStart, rangeEnd, dateKeys, startYmd, endYmd } = parsed;
  const statusMatch = orderStatusExcludeMatch();

  const rangeOrMatch = {
    $or: [
      { orderBookingDate: { $gte: rangeStart, $lte: rangeEnd } },
      {
        deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null },
      },
    ],
  };

  const [
    metricSlices,
    bookingRows,
    uniquePerDayRows,
    rangeUniqueAgg,
    varietyTableResult,
    dueSummary,
    pastDueRow,
  ] = await Promise.all([
    fetchMisMetricSlices(rangeStart, rangeEnd, { dueOnly }),
    Order.aggregate([
      {
        $match: {
          ...statusMatch,
          orderBookingDate: { $gte: rangeStart, $lte: rangeEnd },
        },
      },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$orderBookingDate",
              timezone: "Asia/Kolkata",
            },
          },
          orders: { $sum: 1 },
          plants: { $sum: "$linePlantTotal" },
        },
      },
    ]),
    Order.aggregate([
      { $match: { ...statusMatch, ...rangeOrMatch } },
      {
        $project: {
          orderId: "$_id",
          days: {
            $filter: {
              input: [
                {
                  $cond: [
                    {
                      $and: [
                        { $gte: ["$orderBookingDate", rangeStart] },
                        { $lte: ["$orderBookingDate", rangeEnd] },
                      ],
                    },
                    istDateStringExpr("orderBookingDate"),
                    null,
                  ],
                },
                {
                  $cond: [
                    {
                      $and: [
                        { $ne: ["$deliveryDate", null] },
                        { $gte: ["$deliveryDate", rangeStart] },
                        { $lte: ["$deliveryDate", rangeEnd] },
                      ],
                    },
                    istDateStringExpr("deliveryDate"),
                    null,
                  ],
                },
              ],
              as: "d",
              cond: { $ne: ["$$d", null] },
            },
          },
        },
      },
      { $unwind: "$days" },
      {
        $group: {
          _id: "$days",
          orderIds: { $addToSet: "$orderId" },
        },
      },
      {
        $project: {
          _id: 1,
          uniqueOrders: { $size: "$orderIds" },
        },
      },
    ]),
    Order.aggregate([
      { $match: { ...statusMatch, ...rangeOrMatch } },
      {
        $group: {
          _id: null,
          uniqueOrders: { $addToSet: "$_id" },
        },
      },
      {
        $project: {
          _id: 0,
          uniqueOrders: { $size: "$uniqueOrders" },
        },
      },
    ]),
    fetchVarietyTableMetrics(rangeStart, rangeEnd, PLANT_SUBTYPE_STAGES, { dueOnly }),
    aggregateDueSummary(rangeStart, rangeEnd, { dueOnly }),
    includeAllPastDue
      ? aggregatePastDueDeliveryRows(rangeStart)
      : Promise.resolve(null),
  ]);

  const varietyTable = varietyTableResult;

  const payload = buildAdminDailyMisPayloadFromMetrics({
    dateKeys,
    bookingRows,
    uniquePerDayRows,
    rangeUniqueOrders: rangeUniqueAgg[0]?.uniqueOrders ?? 0,
    ...metricSlices,
    dueOnly,
  });

  if (includeAllPastDue && dueSummary?.combined) {
    payload.totals.delivery.total = { ...dueSummary.combined };
  }

  const days = pastDueRow ? [pastDueRow, ...payload.days] : payload.days;

  return {
    data: {
      ...payload,
      days,
      startDate: startYmd,
      endDate: endYmd,
      varietyTable: varietyTable.rows,
      varietyTotals: varietyTable.totals,
      dueSummary,
      dueOnly,
      includeAllPastDue,
    },
  };
}
