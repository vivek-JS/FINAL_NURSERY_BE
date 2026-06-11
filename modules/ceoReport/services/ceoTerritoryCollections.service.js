import Order from "../../../models/order.model.js";
import { parseCeoReportQuery } from "../utility/ceoQueryParams.js";
import { parseYmdRange } from "../../../utility/istOrderDateStats.js";
import {
  baseCollectionPipeline,
  buildCollectionMatch,
} from "../utility/ceoCollectionPipeline.js";
import { collectionRisk } from "../utility/ceoTerritoryRisk.js";

const IST = "Asia/Kolkata";
const CUSTOMER_LIMIT = 2500;

function branchId(name) {
  const slug = String(name || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "unknown";
}

function villageId(branch, village) {
  return `${branchId(branch)}__${String(village || "unknown").trim().toLowerCase().replace(/\s+/g, "-")}`;
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

function deriveStatus(outstanding, daysOverdue) {
  if (outstanding <= 0) return "closed";
  if (daysOverdue > 90) return "npa";
  if (daysOverdue > 0) return "overdue";
  return "active";
}

function mapCustomerRow(row) {
  const bName = row.branch || "—";
  const vName = row.village || "Unknown";
  const outstanding = Math.round(row.outstandingAmount ?? 0);
  const collected = Math.round(row.collectionAmount ?? 0);
  const orderAmount = Math.round(row.orderAmount ?? 0);
  const daysOverdue = Math.max(0, Math.round(row.daysOverdue ?? 0));
  const bookingYmd = row.bookingDate
    ? new Date(row.bookingDate).toLocaleDateString("en-CA", { timeZone: IST })
    : "";
  const dueYmd = row.dueDate
    ? new Date(row.dueDate).toLocaleDateString("en-CA", { timeZone: IST })
    : "";

  return {
    id: String(row._id),
    orderId: row.orderId ?? row._id,
    name: row.customerName || "Unknown",
    orderNumber: row.orderId != null ? String(row.orderId) : String(row._id).slice(-8),
    orderAmount,
    advanceAmount: Math.round(row.advanceAmount ?? 0),
    collected,
    pending: outstanding,
    dueDate: dueYmd,
    bookingDate: bookingYmd,
    branchId: branchId(bName),
    branchName: bName,
    villageId: villageId(bName, vName),
    villageName: vName,
    taluka: row.taluka || "",
    district: row.district || "",
    salesmanName: row.salesmanName || "",
    status: deriveStatus(outstanding, daysOverdue),
    daysOverdue,
    productName: row.productName || "",
  };
}

function aggregateVillages(customers) {
  const groups = new Map();
  for (const c of customers) {
    const list = groups.get(c.villageId) ?? [];
    list.push(c);
    groups.set(c.villageId, list);
  }

  return [...groups.entries()].map(([id, list]) => {
    const orderAmount = list.reduce((s, c) => s + c.orderAmount, 0);
    const collected = list.reduce((s, c) => s + c.collected, 0);
    const pending = list.reduce((s, c) => s + c.pending, 0);
    const collectionPct = orderAmount > 0 ? (collected / orderAmount) * 100 : 0;
    const overdueAccounts = list.filter((c) => c.status === "overdue" || c.status === "npa").length;
    const overdueAmount = list.filter((c) => c.daysOverdue > 0).reduce((s, c) => s + c.pending, 0);

    return {
      id,
      name: list[0]?.villageName ?? id,
      branchId: list[0]?.branchId ?? "",
      customerCount: list.length,
      orderCount: list.length,
      bookedAmount: Math.round(orderAmount),
      collectedAmount: Math.round(collected),
      collectionPct: Math.round(collectionPct),
      pendingAmount: Math.round(pending),
      overdueAccounts,
      overdueAmount: Math.round(overdueAmount),
      growthPct: 0,
      riskLevel: collectionRisk(collectionPct),
    };
  });
}

function aggregateBranches(customers, prevCollectedByBranch) {
  const groups = new Map();
  for (const c of customers) {
    const list = groups.get(c.branchId) ?? [];
    list.push(c);
    groups.set(c.branchId, list);
  }

  return [...groups.entries()]
    .map(([id, list]) => {
      const orderAmount = list.reduce((s, c) => s + c.orderAmount, 0);
      const collected = list.reduce((s, c) => s + c.collected, 0);
      const overdue = list.filter((c) => c.daysOverdue > 0).reduce((s, c) => s + c.pending, 0);
      const collectionPct = orderAmount > 0 ? (collected / orderAmount) * 100 : 0;
      const prevCollected = prevCollectedByBranch.get(id) ?? 0;
      const growthPct =
        prevCollected > 0 ? Math.round(((collected - prevCollected) / prevCollected) * 1000) / 10 : collected > 0 ? 100 : 0;
      const villageIds = new Set(list.map((c) => c.villageId));

      return {
        id,
        name: list[0]?.branchName ?? id,
        totalCustomers: list.length,
        activeOrders: list.filter((c) => c.status === "active" || c.status === "overdue").length,
        bookedAmount: Math.round(orderAmount),
        collectedAmount: Math.round(collected),
        collectionPct: Math.round(collectionPct),
        overdueAmount: Math.round(overdue),
        collectionRate: Math.round(collectionPct),
        growthPct,
        riskLevel: collectionRisk(collectionPct),
        villageCount: villageIds.size,
      };
    })
    .sort((a, b) => b.collectedAmount - a.collectedAmount);
}

function buildSummary(customers, branchCount) {
  const booked = customers.reduce((s, c) => s + c.orderAmount, 0);
  const collected = customers.reduce((s, c) => s + c.collected, 0);
  const overdueAmount = customers.filter((c) => c.daysOverdue > 0).reduce((s, c) => s + c.pending, 0);
  return {
    totalBranches: branchCount,
    totalCustomers: customers.length,
    totalBooked: Math.round(booked),
    totalCollected: Math.round(collected),
    collectionPct: booked > 0 ? Math.round((collected / booked) * 100) : 0,
    overdueAmount: Math.round(overdueAmount),
    highRiskCustomers: customers.filter((c) => c.daysOverdue > 90).length,
  };
}

async function fetchCustomerRows(rangeStart, rangeEnd, extraMatch, dateField, limit = CUSTOMER_LIMIT) {
  const match = buildCollectionMatch(rangeStart, rangeEnd, extraMatch, dateField);
  const now = new Date();
  const pipeline = [
    ...baseCollectionPipeline(match, limit),
    {
      $addFields: {
        daysOverdue: {
          $cond: [
            {
              $and: [
                { $gt: ["$outstandingAmount", 0] },
                { $ne: ["$dueDate", null] },
                { $lt: ["$dueDate", now] },
              ],
            },
            {
              $divide: [{ $subtract: [now, "$dueDate"] }, 86400000],
            },
            0,
          ],
        },
      },
    },
    {
      $project: {
        orderId: 1,
        customerName: 1,
        village: 1,
        taluka: 1,
        district: 1,
        salesmanName: 1,
        branch: 1,
        productName: 1,
        orderAmount: 1,
        collectionAmount: 1,
        outstandingAmount: 1,
        advanceAmount: 1,
        dueDate: 1,
        bookingDate: 1,
        daysOverdue: 1,
      },
    },
  ];

  const rows = await Order.aggregate(pipeline).allowDiskUse(true);
  return rows.map(mapCustomerRow);
}

export async function fetchCeoTerritoryCollections(query = {}) {
  const opts = parseCeoReportQuery(query);
  if (opts.error) return { error: opts.error, statusCode: 400 };

  const dateField = String(query.dateField || "booking").toLowerCase();
  const comparePrevious = String(query.comparePrevious ?? "true") !== "false";
  const branchFilter = String(query.branchId || "").trim();
  const { rangeStart, rangeEnd, startYmd, endYmd, depth, extraMatch } = opts;

  const prev = comparePrevious ? previousRangeFrom(startYmd, endYmd) : null;

  const [customers, prevCustomers] = await Promise.all([
    fetchCustomerRows(rangeStart, rangeEnd, extraMatch, dateField),
    prev ? fetchCustomerRows(prev.rangeStart, prev.rangeEnd, extraMatch, dateField) : Promise.resolve([]),
  ]);

  const prevCollectedByBranch = new Map();
  for (const c of prevCustomers) {
    prevCollectedByBranch.set(c.branchId, (prevCollectedByBranch.get(c.branchId) ?? 0) + c.collected);
  }

  let filtered = customers;
  if (branchFilter) {
    filtered = customers.filter((c) => c.branchId === branchFilter);
  }

  const branches = aggregateBranches(customers, prevCollectedByBranch);
  const villages = aggregateVillages(filtered);
  const villagesByBranch = {};
  for (const v of aggregateVillages(customers)) {
    const list = villagesByBranch[v.branchId] ?? [];
    list.push(v);
    villagesByBranch[v.branchId] = list;
  }
  for (const key of Object.keys(villagesByBranch)) {
    villagesByBranch[key].sort((a, b) => b.collectedAmount - a.collectedAmount);
  }

  const summary = buildSummary(customers, branches.length);
  const previousSummary = prevCustomers.length ? buildSummary(prevCustomers, branches.length) : null;

  const payload = {
    tab: "territory-collections",
    timezone: IST,
    depth,
    dateField,
    range: { startDate: startYmd, endDate: endYmd },
    previousRange: prev ? { startDate: prev.startYmd, endDate: prev.endYmd } : null,
    summary,
    previousSummary,
    branches,
    villages: branchFilter || depth === "full" ? villages : undefined,
    villagesByBranch: depth === "full" ? villagesByBranch : undefined,
    customers: depth === "full" ? filtered : undefined,
    previousCustomers: depth === "full" ? prevCustomers : undefined,
  };

  return { data: payload };
}
