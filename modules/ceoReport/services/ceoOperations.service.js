import Order from "../../../models/order.model.js";
import Dispatch from "../../../models/dispatch.model.js";
import {
  orderStatusExcludeMatch,
  LINE_PLANT_TOTAL_ADD_FIELDS,
} from "../../../utility/istOrderDateStats.js";
import { fetchMisMetricSlices } from "../../../utility/adminMisMetrics.js";
import { aggregateGeoTop } from "../utility/ceoGeoBreakdown.js";
import { parseCeoReportQuery } from "../utility/ceoQueryParams.js";

const PIPELINE_STAGES = [
  { key: "booking", status: null, label: "Booking" },
  { key: "pending", status: "PENDING", label: "Pending" },
  { key: "accepted", status: "ACCEPTED", label: "Accepted" },
  { key: "farmready", status: "FARM_READY", label: "Farm ready" },
  { key: "ready_for_dispatch", status: "READY_FOR_DISPATCH", label: "Ready for dispatch" },
  { key: "dispatch_process", status: "DISPATCH_PROCESS", label: "In dispatch" },
  { key: "completed", status: "COMPLETED", label: "Completed" },
];

export async function fetchCeoOperations(query = {}) {
  const opts = parseCeoReportQuery(query);
  if (opts.error) return { error: opts.error, statusCode: 400 };

  const { rangeStart, rangeEnd, startYmd, endYmd, depth, extraMatch } = opts;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const [tabCounts, queueRows, todayBooking, todayDispatch, metricSlices, geoTop] =
    await Promise.all([
      aggregateTabCounts(extraMatch),
      aggregateQueueBySales(rangeStart, rangeEnd, extraMatch),
      Order.aggregate([
        {
          $match: {
            ...orderStatusExcludeMatch(),
            ...extraMatch,
            orderBookingDate: { $gte: todayStart, $lte: todayEnd },
          },
        },
        {
          $group: {
            _id: null,
            orders: { $sum: 1 },
            plants: { $sum: { $ifNull: ["$numberOfPlants", 0] } },
          },
        },
      ]),
      Dispatch.countDocuments({
        createdAt: { $gte: todayStart, $lte: todayEnd },
      }),
      fetchMisMetricSlices(rangeStart, rangeEnd, {}),
      aggregateGeoTop(rangeStart, rangeEnd, extraMatch, { limit: 8 }),
    ]);

  const pipelineFunnel = PIPELINE_STAGES.map((stage) => ({
    ...stage,
    count: tabCounts[stage.key] ?? 0,
  }));

  const grandQueue = queueRows.reduce(
    (acc, r) => ({
      orders: acc.orders + (r.orderCount || 0),
      plants: acc.plants + (r.totalPlants || 0),
    }),
    { orders: 0, plants: 0 }
  );

  const payload = {
    tab: "operations",
    timezone: "Asia/Kolkata",
    depth,
    range: { startDate: startYmd, endDate: endYmd },
    summary: {
      queueDepth: grandQueue,
      todayBookings: todayBooking[0] || { orders: 0, plants: 0 },
      todayDispatches: todayDispatch,
      outWithVehicle: metricSlices.vehicleDispatchedByDay
        ? sumDayMap(metricSlices.vehicleDispatchedByDay)
        : { orders: 0, plants: 0 },
      pipelineSnapshot: tabCounts,
    },
    pipelineFunnel,
    geoTop,
  };

  if (depth !== "summary") {
    payload.queueBySales = queueRows.slice(0, 25);
    payload.periods = pipelineFunnel.map((s) => ({
      key: s.key,
      label: s.label,
      count: s.count,
    }));
  }

  return { data: payload };
}

async function aggregateTabCounts(extraMatch) {
  const statuses = PIPELINE_STAGES.filter((s) => s.status).map((s) => s.status);
  const rows = await Order.aggregate([
    {
      $match: {
        ...orderStatusExcludeMatch(),
        ...extraMatch,
        orderStatus: { $in: statuses },
      },
    },
    { $group: { _id: "$orderStatus", count: { $sum: 1 } } },
  ]);

  const bookingCount = await Order.countDocuments({
    ...orderStatusExcludeMatch(),
    ...extraMatch,
  });

  const map = { booking: bookingCount };
  for (const r of rows) {
    const stage = PIPELINE_STAGES.find((s) => s.status === r._id);
    if (stage) map[stage.key] = r.count;
  }
  return map;
}

async function aggregateQueueBySales(rangeStart, rangeEnd, extraMatch) {
  const REMAINING = [
    "ACCEPTED",
    "FARM_READY",
    "READY_FOR_DISPATCH",
    "DISPATCH_PROCESS",
  ];

  return Order.aggregate([
    {
      $match: {
        ...orderStatusExcludeMatch(),
        ...extraMatch,
        orderStatus: { $in: REMAINING },
        deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null },
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "salesPerson",
        foreignField: "_id",
        as: "sp",
        pipeline: [{ $project: { name: 1 } }],
      },
    },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    {
      $group: {
        _id: {
          salesPersonId: "$salesPerson",
          orderStatus: "$orderStatus",
        },
        orderCount: { $sum: 1 },
        totalPlants: { $sum: "$linePlantTotal" },
        salesName: { $first: { $arrayElemAt: ["$sp.name", 0] } },
      },
    },
    {
      $project: {
        _id: 0,
        salesPersonId: "$_id.salesPersonId",
        orderStatus: "$_id.orderStatus",
        orderCount: 1,
        totalPlants: 1,
        salesName: 1,
      },
    },
    { $sort: { totalPlants: -1 } },
  ]);
}

function sumDayMap(dayMap) {
  let orders = 0;
  let plants = 0;
  if (!dayMap) return { orders, plants };
  for (const v of dayMap.values()) {
    orders += v.orders || 0;
    plants += v.plants || 0;
  }
  return { orders, plants };
}
