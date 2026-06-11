import Order from "../../../models/order.model.js";
import { parseCeoReportQuery } from "../utility/ceoQueryParams.js";
import { parseYmdRange } from "../../../utility/istOrderDateStats.js";
import {
  baseCollectionPipeline,
  buildCollectionMatch,
  collectionFacetStages,
} from "../utility/ceoCollectionPipeline.js";
import { generateCollectionInsights } from "../utility/ceoCollectionInsights.js";

function mapSummaryDoc(doc = {}) {
  const orderAmount = doc.orderAmount ?? 0;
  const collectionAmount = doc.collectionAmount ?? 0;
  return {
    orderCount: doc.orderCount ?? 0,
    orderAmount: Math.round(orderAmount),
    collectionAmount: Math.round(collectionAmount),
    outstandingAmount: Math.round(doc.outstandingAmount ?? 0),
    advanceAmount: Math.round(doc.advanceAmount ?? 0),
    collectionPct: orderAmount > 0 ? Math.round((collectionAmount / orderAmount) * 100) : 0,
    avgDelayDays: doc.avgDelayDays != null ? Math.round(doc.avgDelayDays) : null,
  };
}

function mapBreakdown(rows, nameKey = "name") {
  return (rows || []).map((r) => {
    const name = r._id?.name ?? r._id ?? "Unknown";
    const id = r._id?.id ?? String(r._id ?? "");
    const orderAmount = r.orderAmount ?? 0;
    const collectionAmount = r.collectionAmount ?? 0;
    return {
      [nameKey]: typeof name === "object" ? name.name : name,
      id: typeof name === "object" ? name.id : id,
      orderCount: r.orderCount ?? 0,
      orderAmount: Math.round(orderAmount),
      collectionAmount: Math.round(collectionAmount),
      outstandingAmount: Math.round(r.outstandingAmount ?? 0),
      collectionPct: orderAmount > 0 ? Math.round((collectionAmount / orderAmount) * 100) : 0,
    };
  });
}

async function aggregatePeriod(rangeStart, rangeEnd, extraMatch, dateField, depth) {
  const match = buildCollectionMatch(rangeStart, rangeEnd, extraMatch, dateField);
  const pipeline = [
    ...baseCollectionPipeline(match),
    { $facet: collectionFacetStages() },
  ];

  const [facet] = await Order.aggregate(pipeline).allowDiskUse(true);
  const summary = mapSummaryDoc(facet?.summary?.[0]);

  const result = {
    summary,
    bySalesman: mapBreakdown(facet?.bySalesman, "salesmanName"),
    byVillage: mapBreakdown(facet?.byVillage, "village"),
    byBranch: mapBreakdown(facet?.byBranch, "branch"),
    byPaymentMode: (facet?.byPaymentMode || []).map((r) => ({
      mode: r._id,
      count: r.count,
      amount: Math.round(r.amount),
    })),
    delayBuckets: (facet?.delayBuckets || []).map((r) => ({
      bucket: r._id,
      count: r.count,
      outstanding: Math.round(r.outstanding ?? 0),
    })),
  };

  if (depth === "full") {
    const rowsPipeline = [
      ...baseCollectionPipeline(match, 400),
      {
        $project: {
          orderId: 1,
          customerName: 1,
          village: 1,
          taluka: 1,
          district: 1,
          salesmanName: 1,
          salesmanId: 1,
          branch: 1,
          productName: 1,
          orderAmount: { $round: ["$orderAmount", 0] },
          collectionAmount: { $round: ["$collectionAmount", 0] },
          outstandingAmount: { $round: ["$outstandingAmount", 0] },
          advanceAmount: { $round: ["$advanceAmount", 0] },
          dueDate: 1,
          bookingDate: 1,
          avgDelayDays: { $round: [{ $ifNull: ["$_avgDelayDays", 0] }, 0] },
          orderStatus: 1,
          orderPaymentStatus: 1,
          payment: {
            $map: {
              input: {
                $filter: {
                  input: { $ifNull: ["$payment", []] },
                  as: "p",
                  cond: { $eq: ["$$p.paymentStatus", "COLLECTED"] },
                },
              },
              as: "p",
              in: {
                amount: "$$p.paidAmount",
                collectionDate: "$$p.paymentDate",
                mode: "$$p.modeOfPayment",
                isAdvance: {
                  $eq: [{ $toLower: { $ifNull: ["$$p.paymentTiming", ""] } }, "advance"],
                },
              },
            },
          },
        },
      },
    ];
    result.rows = await Order.aggregate(rowsPipeline).allowDiskUse(true);
  }

  return result;
}

function previousRangeFrom(startYmd, endYmd) {
  const parsed = parseYmdRange(startYmd, endYmd);
  if (parsed.error) return null;
  const { dayCount, rangeStart } = parsed;
  const prevEndMs = rangeStart.getTime() - 1;
  const prevStartMs = prevEndMs - (dayCount - 1) * 86400000;
  const fmtIst = (ms) => {
    const d = new Date(ms);
    return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  };
  return parseYmdRange(fmtIst(prevStartMs), fmtIst(prevEndMs));
}

export async function fetchCeoSalesCollectionAnalytics(query = {}) {
  const opts = parseCeoReportQuery(query);
  if (opts.error) return { error: opts.error, statusCode: 400 };

  const dateField = String(query.dateField || "booking").toLowerCase();
  const comparePrevious = String(query.comparePrevious ?? "true") !== "false";
  const { rangeStart, rangeEnd, startYmd, endYmd, depth, extraMatch } = opts;

  const prev = comparePrevious ? previousRangeFrom(startYmd, endYmd) : null;

  const [current, previous] = await Promise.all([
    aggregatePeriod(rangeStart, rangeEnd, extraMatch, dateField, depth),
    prev
      ? aggregatePeriod(prev.rangeStart, prev.rangeEnd, extraMatch, dateField, "summary")
      : Promise.resolve(null),
  ]);

  const insights = generateCollectionInsights({
    current,
    previous: previous || { summary: {} },
    bySalesman: current.bySalesman,
    byVillage: current.byVillage,
    delayBuckets: current.delayBuckets,
    byPaymentMode: current.byPaymentMode,
  });

  const payload = {
    tab: "sales-collection-analytics",
    timezone: "Asia/Kolkata",
    depth,
    dateField,
    range: { startDate: startYmd, endDate: endYmd },
    previousRange: prev ? { startDate: prev.startYmd, endDate: prev.endYmd } : null,
    summary: current.summary,
    previousSummary: previous?.summary ?? null,
    breakdowns: {
      bySalesman: current.bySalesman,
      byVillage: current.byVillage,
      byBranch: current.byBranch,
      byPaymentMode: current.byPaymentMode,
      delayBuckets: current.delayBuckets,
    },
    insights,
    rows: current.rows ?? undefined,
  };

  return { data: payload };
}
