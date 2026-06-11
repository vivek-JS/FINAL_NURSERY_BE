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

async function aggregatePerformance(rangeStart, rangeEnd, extraMatch, granularity) {
  const match = buildCollectionMatch(rangeStart, rangeEnd, extraMatch, "booking");
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

export async function fetchCeoSalesPerformance(query = {}) {
  const opts = parseCeoReportQuery(query);
  if (opts.error) return { error: opts.error, statusCode: 400 };

  const rawGranularity = String(query.granularity || "daily").toLowerCase();
  const granularity = ["daily", "weekly", "monthly"].includes(rawGranularity) ? rawGranularity : "daily";
  const comparePrevious = String(query.comparePrevious ?? "true") !== "false";
  const { rangeStart, rangeEnd, startYmd, endYmd, depth, extraMatch } = opts;

  const prev = comparePrevious ? previousRangeFrom(startYmd, endYmd) : null;

  const [records, prevRecords] = await Promise.all([
    aggregatePerformance(rangeStart, rangeEnd, extraMatch, granularity),
    prev
      ? aggregatePerformance(prev.rangeStart, prev.rangeEnd, extraMatch, granularity)
      : Promise.resolve([]),
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
    range: { startDate: startYmd, endDate: endYmd },
    previousRange: prev ? { startDate: prev.startYmd, endDate: prev.endYmd } : null,
    summary: { ...summary, growthPct },
    previousSummary,
    records: depth === "summary" ? undefined : records,
  };

  return { data: payload };
}
