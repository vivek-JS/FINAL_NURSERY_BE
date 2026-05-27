import Order from "../models/order.model.js";
import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
  istDateStringExpr,
  parseYmdRange,
} from "../utility/istOrderDateStats.js";
import {
  buildAdminDailyMisPayload,
  buildVarietyTable,
} from "../utility/adminDailyMisMerge.js";

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

const REMAINING_STATUSES = [
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
];

export async function fetchAdminDailyMis(startDate, endDate) {
  const parsed = parseYmdRange(startDate, endDate);
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
    bookingRows,
    deliveryRows,
    uniquePerDayRows,
    rangeUniqueAgg,
    varietyBookingRows,
    varietyDeliveryRows,
  ] = await Promise.all([
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
        {
          $match: {
            ...statusMatch,
            deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null },
          },
        },
        { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
        {
          $group: {
            _id: {
              day: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$deliveryDate",
                  timezone: "Asia/Kolkata",
                },
              },
              status: "$orderStatus",
            },
            orders: { $sum: 1 },
            plants: { $sum: "$linePlantTotal" },
            plantsRemaining: {
              $sum: {
                $cond: [
                  { $in: ["$orderStatus", REMAINING_STATUSES] },
                  { $ifNull: ["$remainingPlants", 0] },
                  0,
                ],
              },
            },
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

      Order.aggregate([
        {
          $match: {
            ...statusMatch,
            orderBookingDate: { $gte: rangeStart, $lte: rangeEnd },
          },
        },
        { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
        ...PLANT_SUBTYPE_STAGES,
        {
          $group: {
            _id: {
              plantName: { $ifNull: ["$_plantTypeName", "Unknown"] },
              subtype: "$_subtypeName",
              plantId: "$plantName",
              subtypeId: "$plantSubtype",
            },
            bookingOrders: { $sum: 1 },
            bookingPlants: { $sum: "$linePlantTotal" },
          },
        },
        {
          $project: {
            _id: 0,
            plantName: "$_id.plantName",
            subtype: "$_id.subtype",
            plantId: "$_id.plantId",
            subtypeId: "$_id.subtypeId",
            bookingOrders: 1,
            bookingPlants: 1,
          },
        },
      ]),

      Order.aggregate([
        {
          $match: {
            ...statusMatch,
            deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null },
          },
        },
        { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
        ...PLANT_SUBTYPE_STAGES,
        {
          $group: {
            _id: {
              plantName: { $ifNull: ["$_plantTypeName", "Unknown"] },
              subtype: "$_subtypeName",
              plantId: "$plantName",
              subtypeId: "$plantSubtype",
              status: "$orderStatus",
            },
            orders: { $sum: 1 },
            plants: { $sum: "$linePlantTotal" },
            plantsRemaining: {
              $sum: {
                $cond: [
                  { $in: ["$orderStatus", REMAINING_STATUSES] },
                  { $ifNull: ["$remainingPlants", 0] },
                  0,
                ],
              },
            },
          },
        },
      ]),
    ]);

  const varietyTable = buildVarietyTable(varietyBookingRows, varietyDeliveryRows);

  const payload = buildAdminDailyMisPayload({
    dateKeys,
    bookingRows,
    deliveryRows,
    uniquePerDayRows,
    rangeUniqueOrders: rangeUniqueAgg[0]?.uniqueOrders ?? 0,
  });

  return {
    data: {
      ...payload,
      startDate: startYmd,
      endDate: endYmd,
      varietyTable: varietyTable.rows,
      varietyTotals: varietyTable.totals,
    },
  };
}
