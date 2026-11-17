import Order from "../../../models/order.model.js";
import { parseCeoReportQuery } from "../utility/ceoQueryParams.js";
import { parseYmdRange } from "../../../utility/istOrderDateStats.js";
import {
  baseCollectionPipeline,
  buildCollectionMatch,
} from "../utility/ceoCollectionPipeline.js";

const IST = "Asia/Kolkata";

const PERIOD_FORMAT = {
  daily: "%Y-%m-%d",
  weekly: "%G-W%V",
  monthly: "%Y-%m",
};

/** sales = company bookings, dealer = dealer bookings, all = both. */
function parseChannel(query = {}) {
  const value = String(query.channel || query.party || "sales").toLowerCase();
  return ["sales", "dealer", "all"].includes(value) ? value : "sales";
}

function salesCollectionMatch(rangeStart, rangeEnd, extraMatch, channel) {
  const match = buildCollectionMatch(rangeStart, rangeEnd, extraMatch, "booking");
  if (channel === "dealer") match.dealerOrder = true;
  else if (channel === "all") delete match.dealerOrder;
  return match;
}

function periodExpr(granularity) {
  const fmt = PERIOD_FORMAT[granularity] || PERIOD_FORMAT.daily;
  return { $dateToString: { format: fmt, date: "$orderBookingDate", timezone: IST } };
}

function previousRangeFrom(startYmd, endYmd) {
  const parsed = parseYmdRange(startYmd, endYmd);
  if (parsed.error) return null;
  const { dayCount, rangeStart } = parsed;
  const prevEndMs = rangeStart.getTime() - 1;
  const prevStartMs = prevEndMs - (dayCount - 1) * 86400000;
  const fmtIst = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: IST });
  return parseYmdRange(fmtIst(prevStartMs), fmtIst(prevEndMs));
}

function mapRecords(rows) {
  return rows.map((r) => ({
    salesmanName: r._id?.salesman || "Unknown",
    salesmanId: r._id?.salesmanId || "",
    date: r._id?.period || "",
    orders: r.orders ?? 0,
    revenue: Math.round(r.revenue ?? 0),
    collectionAmount: Math.round(r.collectionAmount ?? 0),
    outstandingAmount: Math.round(r.outstandingAmount ?? 0),
    productQuantity: Math.round(r.productQuantity ?? 0),
    newCustomers: r.newCustomers ?? 0,
    region: r.region || "—",
    customerName: "",
    productName: "",
  }));
}

function buildSummary(records) {
  const revenue = records.reduce((s, r) => s + r.revenue, 0);
  const collection = records.reduce((s, r) => s + r.collectionAmount, 0);
  const orders = records.reduce((s, r) => s + r.orders, 0);
  const outstanding = records.reduce((s, r) => s + r.outstandingAmount, 0);
  const plants = records.reduce((s, r) => s + r.productQuantity, 0);
  const farmers = records.reduce((s, r) => s + r.newCustomers, 0);

  const bySalesman = new Map();
  for (const r of records) {
    const cur = bySalesman.get(r.salesmanName) ?? { name: r.salesmanName, revenue: 0, orders: 0, collection: 0 };
    cur.revenue += r.revenue;
    cur.orders += r.orders;
    cur.collection += r.collectionAmount;
    bySalesman.set(r.salesmanName, cur);
  }
  const top = [...bySalesman.values()].sort((a, b) => b.revenue - a.revenue)[0];

  return {
    totalRevenue: revenue,
    totalCollection: collection,
    totalOrders: orders,
    totalOutstanding: outstanding,
    totalPlants: plants,
    collectionPct: revenue > 0 ? Math.round((collection / revenue) * 100) : 0,
    outstandingPct: revenue > 0 ? Math.round((outstanding / revenue) * 100) : 0,
    avgOrderValue: orders > 0 ? Math.round(revenue / orders) : 0,
    newCustomers: farmers,
    bestSalesman: top?.name ?? "—",
    salesmanCount: bySalesman.size,
  };
}

async function aggregatePerformance(rangeStart, rangeEnd, extraMatch, granularity, channel = "sales") {
  const match = salesCollectionMatch(rangeStart, rangeEnd, extraMatch, channel);
  const pipeline = [
    ...baseCollectionPipeline(match),
    {
      $group: {
        _id: {
          salesman: "$salesmanName",
          salesmanId: "$salesmanId",
          period: periodExpr(granularity),
        },
        orders: { $sum: 1 },
        revenue: { $sum: "$orderAmount" },
        collectionAmount: { $sum: "$collectionAmount" },
        outstandingAmount: { $sum: "$outstandingAmount" },
        productQuantity: { $sum: "$linePlantTotal" },
        regions: { $addToSet: "$district" },
        farmers: { $addToSet: "$farmer" },
      },
    },
    {
      $project: {
        _id: 1,
        orders: 1,
        revenue: 1,
        collectionAmount: 1,
        outstandingAmount: 1,
        productQuantity: 1,
        region: { $arrayElemAt: [{ $filter: { input: "$regions", as: "r", cond: { $ne: ["$$r", ""] } } }, 0] },
        newCustomers: { $size: "$farmers" },
      },
    },
    { $sort: { "_id.period": 1, revenue: -1 } },
  ];

  const rows = await Order.aggregate(pipeline).allowDiskUse(true);
  return mapRecords(rows);
}

/** Plants, orders, and revenue per salesman and tray cavity. */
async function aggregateCavities(rangeStart, rangeEnd, extraMatch, channel = "sales") {
  const match = salesCollectionMatch(rangeStart, rangeEnd, extraMatch, channel);
  const pipeline = [
    ...baseCollectionPipeline(match),
    {
      $addFields: {
        _cavityLines: {
          $cond: [
            { $gt: [{ $size: { $ifNull: ["$plantLineItems", []] } }, 0] },
            {
              $map: {
                input: "$plantLineItems",
                as: "line",
                in: {
                  cavity: "$$line.cavity",
                  plants: { $ifNull: ["$$line.numberOfPlants", 0] },
                  revenue: {
                    $multiply: [
                      { $ifNull: ["$$line.numberOfPlants", 0] },
                      { $ifNull: ["$$line.rate", 0] },
                    ],
                  },
                },
              },
            },
            [{ cavity: "$cavity", plants: "$linePlantTotal", revenue: "$orderAmount" }],
          ],
        },
      },
    },
    { $unwind: "$_cavityLines" },
    {
      $addFields: {
        _lineCollection: {
          $cond: [
            { $gt: ["$linePlantTotal", 0] },
            { $multiply: ["$collectionAmount", { $divide: ["$_cavityLines.plants", "$linePlantTotal"] }] },
            0,
          ],
        },
      },
    },
    {
      $lookup: {
        from: "trays",
        localField: "_cavityLines.cavity",
        foreignField: "_id",
        pipeline: [{ $project: { name: 1, cavity: 1 } }],
        as: "_tray",
      },
    },
    {
      $group: {
        _id: {
          salesman: "$salesmanName",
          cavity: { $ifNull: [{ $arrayElemAt: ["$_tray.name", 0] }, "No cavity"] },
          size: { $ifNull: [{ $arrayElemAt: ["$_tray.cavity", 0] }, 0] },
        },
        orderIds: { $addToSet: "$_id" },
        revenue: { $sum: "$_cavityLines.revenue" },
        collectionAmount: { $sum: "$_lineCollection" },
        productQuantity: { $sum: "$_cavityLines.plants" },
      },
    },
    { $sort: { productQuantity: -1, revenue: -1 } },
  ];
  const rows = await Order.aggregate(pipeline).allowDiskUse(true);
  return rows.map((row) => ({
    salesmanName: row._id?.salesman || "Unknown",
    cavityName: row._id?.cavity || "No cavity",
    cavitySize: Number(row._id?.size) || 0,
    orders: row.orderIds?.length ?? 0,
    revenue: Math.round(row.revenue ?? 0),
    collectionAmount: Math.round(row.collectionAmount ?? 0),
    productQuantity: Math.round(row.productQuantity ?? 0),
  }));
}

function varietyName(crop, subtype) {
  const plant = String(crop || "").trim();
  const variety = String(subtype || "").trim();
  if (!plant) return variety || "Unknown plant";
  return variety ? `${plant} · ${variety}` : plant;
}

/** Booked plants per variety (crop + subtype) and salesman. */
async function aggregatePlants(rangeStart, rangeEnd, extraMatch, channel = "sales") {
  const match = salesCollectionMatch(rangeStart, rangeEnd, extraMatch, channel);
  const pipeline = [
    ...baseCollectionPipeline(match),
    {
      $addFields: {
        _plantLines: {
          $cond: [
            { $gt: [{ $size: { $ifNull: ["$plantLineItems", []] } }, 0] },
            {
              $map: {
                input: "$plantLineItems",
                as: "line",
                in: {
                  plantId: "$$line.plantName",
                  subtypeId: "$$line.plantSubtype",
                  plantLabel: { $ifNull: ["$$line.plantNameSnapshot", ""] },
                  subtypeLabel: { $ifNull: ["$$line.plantSubtypeSnapshot", ""] },
                  plants: { $ifNull: ["$$line.numberOfPlants", 0] },
                  revenue: {
                    $multiply: [
                      { $ifNull: ["$$line.numberOfPlants", 0] },
                      { $ifNull: ["$$line.rate", 0] },
                    ],
                  },
                },
              },
            },
            [
              {
                plantId: "$plantName",
                subtypeId: "$plantSubtype",
                plantLabel: { $ifNull: ["$_plantDoc.name", ""] },
                subtypeLabel: { $ifNull: ["$_subtypeName", ""] },
                plants: "$linePlantTotal",
                revenue: "$orderAmount",
              },
            ],
          ],
        },
      },
    },
    { $unwind: "$_plantLines" },
    {
      $lookup: {
        from: "plantcms",
        localField: "_plantLines.plantId",
        foreignField: "_id",
        pipeline: [{ $project: { name: 1, "subtypes._id": 1, "subtypes.name": 1 } }],
        as: "_crop",
      },
    },
    {
      $addFields: {
        _cropDoc: { $arrayElemAt: ["$_crop", 0] },
        _lineCollection: {
          $cond: [
            { $gt: ["$linePlantTotal", 0] },
            { $multiply: ["$collectionAmount", { $divide: ["$_plantLines.plants", "$linePlantTotal"] }] },
            0,
          ],
        },
      },
    },
    {
      $addFields: {
        _cropName: {
          $cond: [
            { $gt: [{ $strLenCP: { $ifNull: ["$_plantLines.plantLabel", ""] } }, 0] },
            "$_plantLines.plantLabel",
            { $ifNull: ["$_cropDoc.name", "Unknown plant"] },
          ],
        },
        _varietyName: {
          $cond: [
            { $gt: [{ $strLenCP: { $ifNull: ["$_plantLines.subtypeLabel", ""] } }, 0] },
            "$_plantLines.subtypeLabel",
            {
              $let: {
                vars: {
                  hit: {
                    $arrayElemAt: [
                      {
                        $filter: {
                          input: { $ifNull: ["$_cropDoc.subtypes", []] },
                          as: "st",
                          cond: { $eq: ["$$st._id", "$_plantLines.subtypeId"] },
                        },
                      },
                      0,
                    ],
                  },
                },
                in: { $ifNull: ["$$hit.name", ""] },
              },
            },
          ],
        },
      },
    },
    {
      $group: {
        _id: { salesman: "$salesmanName", plant: "$_cropName", variety: "$_varietyName" },
        orderIds: { $addToSet: "$_id" },
        revenue: { $sum: "$_plantLines.revenue" },
        collectionAmount: { $sum: "$_lineCollection" },
        productQuantity: { $sum: "$_plantLines.plants" },
      },
    },
    { $sort: { productQuantity: -1, revenue: -1 } },
  ];
  const rows = await Order.aggregate(pipeline).allowDiskUse(true);
  return rows.map((row) => ({
    plantName: varietyName(row._id?.plant, row._id?.variety),
    salesmanName: row._id?.salesman || "Unknown",
    orders: row.orderIds?.length ?? 0,
    revenue: Math.round(row.revenue ?? 0),
    collectionAmount: Math.round(row.collectionAmount ?? 0),
    productQuantity: Math.round(row.productQuantity ?? 0),
  }));
}

const ORDER_LIST_LIMIT = 200;

/** One row per booked order for the salesperson, newest first. */
async function fetchSalesOrders(rangeStart, rangeEnd, extraMatch, salesman, plant, channel = "sales") {
  const match = salesCollectionMatch(rangeStart, rangeEnd, extraMatch, channel);
  const pipeline = [
    ...baseCollectionPipeline(match),
    {
      $match: {
        $expr: {
          $eq: [
            { $toLower: { $trim: { input: { $ifNull: ["$salesmanName", ""] } } } },
            salesman.toLowerCase(),
          ],
        },
      },
    },
  ];
  if (plant) {
    const [crop, ...rest] = plant.split(" · ");
    const subtype = rest.join(" · ").trim();
    const cropName = crop.trim();
    const text = (path) => ({ $trim: { input: { $ifNull: [path, ""] } } });
    const sameVariety = (plantPath, subtypePath) => ({
      $and: [
        { $eq: [text(plantPath), cropName] },
        ...(subtype ? [{ $eq: [text(subtypePath), subtype] }] : []),
      ],
    });
    pipeline.push({
      $match: {
        $expr: {
          $or: [
            {
              $and: [
                { $eq: [{ $size: { $ifNull: ["$plantLineItems", []] } }, 0] },
                sameVariety("$_plantDoc.name", "$_subtypeName"),
              ],
            },
            {
              $gt: [
                {
                  $size: {
                    $filter: {
                      input: { $ifNull: ["$plantLineItems", []] },
                      as: "line",
                      cond: sameVariety("$$line.plantNameSnapshot", "$$line.plantSubtypeSnapshot"),
                    },
                  },
                },
                0,
              ],
            },
          ],
        },
      },
    });
  }
  pipeline.push(
    {
      $lookup: {
        from: "trays",
        localField: "cavity",
        foreignField: "_id",
        pipeline: [{ $project: { name: 1 } }],
        as: "_tray",
      },
    },
    { $sort: { orderBookingDate: -1, orderId: -1 } },
    {
      $facet: {
        meta: [{ $count: "total" }],
        orders: [
          { $limit: ORDER_LIST_LIMIT },
          {
            $project: {
              _id: 0,
              orderId: 1,
              status: { $ifNull: ["$orderStatus", ""] },
              farmerName: { $ifNull: ["$customerName", ""] },
              village: { $ifNull: ["$village", ""] },
              plantName: {
                $cond: [
                  { $gt: [{ $size: { $ifNull: ["$plantLineItems", []] } }, 0] },
                  {
                    $reduce: {
                      input: "$plantLineItems",
                      initialValue: "",
                      in: {
                        $concat: [
                          "$$value",
                          { $cond: [{ $eq: ["$$value", ""] }, "", " · "] },
                          { $ifNull: ["$$this.plantNameSnapshot", "Plant"] },
                          {
                            $cond: [
                              { $gt: [{ $strLenCP: { $ifNull: ["$$this.plantSubtypeSnapshot", ""] } }, 0] },
                              { $concat: [" · ", "$$this.plantSubtypeSnapshot"] },
                              "",
                            ],
                          },
                        ],
                      },
                    },
                  },
                  { $ifNull: ["$productName", ""] },
                ],
              },
              plants: "$linePlantTotal",
              revenue: "$orderAmount",
              collectionAmount: "$collectionAmount",
              bookingDate: "$orderBookingDate",
              deliveryDate: {
                $ifNull: ["$deliveryDate", { $arrayElemAt: ["$plantLineItems.deliveryDate", 0] }],
              },
              cavityName: { $ifNull: [{ $arrayElemAt: ["$_tray.name", 0] }, ""] },
            },
          },
        ],
      },
    },
  );
  const [row] = await Order.aggregate(pipeline).allowDiskUse(true);
  const orders = (row?.orders || []).map((order) => ({
    orderId: order.orderId ?? "",
    status: order.status || "",
    farmerName: order.farmerName || "Farmer",
    village: order.village || "",
    plantName: String(order.plantName || "").replace(/\s+/g, " ").trim() || "Plant",
    plants: Math.round(order.plants || 0),
    revenue: Math.round(order.revenue || 0),
    collectionAmount: Math.round(order.collectionAmount || 0),
    bookingDate: order.bookingDate || null,
    deliveryDate: order.deliveryDate || null,
    cavityName: order.cavityName || "",
  }));
  return { orders, total: row?.meta?.[0]?.total ?? orders.length };
}

export async function fetchCeoSalesPerformance(query = {}) {
  const opts = parseCeoReportQuery(query);
  if (opts.error) return { error: opts.error, statusCode: 400 };

  const channel = parseChannel(query);
  const salesman = String(query.salesman || "").trim();
  if (salesman) {
    const plant = String(query.plant || "").trim();
    const { orders, total } = await fetchSalesOrders(opts.rangeStart, opts.rangeEnd, opts.extraMatch, salesman, plant, channel);
    return {
      data: {
        salesman,
        plant: plant || null,
        channel,
        range: { startDate: opts.startYmd, endDate: opts.endYmd },
        total,
        orders,
      },
    };
  }

  const rawGranularity = String(query.granularity || "daily").toLowerCase();
  const granularity = ["daily", "weekly", "monthly"].includes(rawGranularity) ? rawGranularity : "daily";
  const comparePrevious = String(query.comparePrevious ?? "true") !== "false";
  const { rangeStart, rangeEnd, startYmd, endYmd, depth, extraMatch } = opts;

  const prev = comparePrevious ? previousRangeFrom(startYmd, endYmd) : null;

  const [records, prevRecords, cavities, plants] = await Promise.all([
    aggregatePerformance(rangeStart, rangeEnd, extraMatch, granularity, channel),
    prev
      ? aggregatePerformance(prev.rangeStart, prev.rangeEnd, extraMatch, granularity, channel)
      : Promise.resolve([]),
    depth === "summary" ? Promise.resolve([]) : aggregateCavities(rangeStart, rangeEnd, extraMatch, channel),
    depth === "summary" ? Promise.resolve([]) : aggregatePlants(rangeStart, rangeEnd, extraMatch, channel),
  ]);

  const summary = buildSummary(records);
  const previousSummary = prevRecords.length ? buildSummary(prevRecords) : null;
  const growthPct =
    previousSummary && previousSummary.totalRevenue > 0
      ? Math.round(((summary.totalRevenue - previousSummary.totalRevenue) / previousSummary.totalRevenue) * 100)
      : 0;

  const payload = {
    tab: "sales-performance",
    timezone: IST,
    depth,
    granularity,
    channel,
    range: { startDate: startYmd, endDate: endYmd },
    previousRange: prev ? { startDate: prev.startYmd, endDate: prev.endYmd } : null,
    summary: { ...summary, growthPct },
    previousSummary,
    records: depth === "summary" ? undefined : records,
    cavities: depth === "summary" ? undefined : cavities,
    plants: depth === "summary" ? undefined : plants,
  };

  return { data: payload };
}
