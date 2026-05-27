/**
 * GET /api/v1/insights/collections/overview
 * Payment / collection analytics for agri-insights-hub Collection Overview tab.
 */
import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";
import { normalizeFarmerMobile } from "../utils/farmerPlantOrderLedgerHelper.js";
import {
  getFirstDispatchAt,
  resolvePaymentTiming,
  getPaymentTimingForApi,
  paymentMatchesTypes,
} from "../utils/paymentTiming.js";

const EXCLUDED_ORDER_STATUSES = ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"];

const EXCLUDED_FARMER_MOBILES = new Set([
  "9823832132",
  "7588686452",
  "7588686453",
]);

const parseDate = (dateStr, isEnd = false) => {
  const [day, month, year] = dateStr.split("-");
  return isEnd
    ? new Date(`${year}-${month}-${day}T23:59:59.999Z`)
    : new Date(`${year}-${month}-${day}T00:00:00.000Z`);
};

function istCalendarDateString(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${day}`;
}

function mapOrderStatusToUi(orderStatus) {
  if (["COMPLETED", "PARTIALLY_COMPLETED"].includes(orderStatus)) return "delivered";
  if (["DISPATCHED", "DISPATCH_PROCESS"].includes(orderStatus)) return "dispatched";
  if (["FARM_READY", "READY_FOR_DISPATCH"].includes(orderStatus)) return "ready";
  return "pending";
}

function sumByPaymentStatus(paymentArr, status) {
  if (!Array.isArray(paymentArr)) return 0;
  return paymentArr
    .filter((p) => p && p.paymentStatus === status)
    .reduce((s, p) => s + (Number(p.paidAmount) || 0), 0);
}

function mapPaymentLines(paymentArr) {
  if (!Array.isArray(paymentArr)) return [];
  return paymentArr
    .filter((p) => p && Number(p.paidAmount) > 0)
    .map((p) => ({
      paymentId: p._id ? String(p._id) : null,
      paidAmount: Number(p.paidAmount) || 0,
      paymentStatus: p.paymentStatus || "",
      paymentDate: p.paymentDate ? new Date(p.paymentDate).toISOString() : null,
      modeOfPayment: p.modeOfPayment || "",
      bankName: p.bankName || "",
      chequeNumber: p.chequeNumber || "",
      remark: p.remark || "",
    }));
}

function orderMatchesPaymentFilters(order, types, statuses) {
  const typeList = parseCommaList(types);
  const statusList = parseCommaList(statuses).map((s) => s.toUpperCase());
  if (!typeList.length && !statusList.length) return true;
  return (order.payments || []).some((p) => {
    const statusOk =
      !statusList.length ||
      statusList.includes(String(p.paymentStatus || "").toUpperCase());
    const typeOk =
      !typeList.length || paymentMatchesTypes(p, order.firstDispatchAt, typeList);
    return statusOk && typeOk;
  });
}

function flattenPaymentEntries(orders, opts = {}) {
  const paymentTypes = parseCommaList(opts.paymentTypes);
  const paymentStatuses = parseCommaList(opts.paymentStatuses).map((s) =>
    s.toUpperCase()
  );
  const { advanceOnly = false } = opts;

  const entries = [];
  for (const o of orders) {
    const payments = o.payments || [];
    for (let i = 0; i < payments.length; i++) {
      const p = payments[i];
      if (!["COLLECTED", "PENDING"].includes(p.paymentStatus)) continue;
      if (
        advanceOnly &&
        !paymentTypes.length &&
        resolvePaymentTiming(p, o.firstDispatchAt) !== "advance"
      ) {
        continue;
      }
      if (paymentStatuses.length && !paymentStatuses.includes(p.paymentStatus)) continue;
      if (paymentTypes.length && !paymentMatchesTypes(p, o.firstDispatchAt, paymentTypes)) {
        continue;
      }

      const timing = getPaymentTimingForApi(p, o.firstDispatchAt);
      entries.push({
        entryId: p.paymentId ? `${o.orderId}-${p.paymentId}` : `${o.orderId}-${i}`,
        paymentId: p.paymentId || null,
        orderId: o.orderId,
        farmerName: o.farmerName,
        district: o.district,
        taluka: o.taluka,
        village: o.village,
        salesperson: o.salesperson,
        salesPersonId: o.salesPersonId,
        variety: o.variety,
        qty: o.qty,
        orderValue: o.totalAmount,
        rawOrderStatus: o.rawOrderStatus,
        orderPaymentStatus: o.orderPaymentStatus,
        bookingDate: o.createdAt,
        deliveryDate: o.deliveryDate,
        dispatchDate: o.firstDispatchAt,
        paidAmount: p.paidAmount,
        paymentStatus: p.paymentStatus,
        paymentDate: p.paymentDate,
        modeOfPayment: p.modeOfPayment,
        bankName: p.bankName,
        chequeNumber: p.chequeNumber,
        remark: p.remark,
        isAdvance: timing === "advance",
        paymentTiming: timing,
      });
    }
  }
  return entries;
}

function computeStatsFromEntries(entries, orders, advanceOnly = false) {
  const uniqueOrders = new Set(entries.map((e) => e.orderId));
  const totalAdvance = entries.reduce((s, e) => s + (Number(e.paidAmount) || 0), 0);
  const base = computeStats(orders);
  return {
    ...base,
    paymentEntryCount: entries.length,
    totalAdvanceAmount: Math.round(totalAdvance),
    uniqueOrderCount: uniqueOrders.size,
    totalCollected: advanceOnly ? Math.round(totalAdvance) : base.totalCollected,
    totalPending: advanceOnly
      ? 0
      : entries
          .filter((e) => e.paymentStatus === "PENDING")
          .reduce((s, e) => s + e.paidAmount, 0),
  };
}

function buildSeriesFromEntries(entries) {
  const byDistrict = new Map();
  const bySales = new Map();
  const byPaymentStatus = new Map();

  for (const e of entries) {
    const dKey = e.district || "Unknown";
    const dEnt = byDistrict.get(dKey) || {
      name: dKey,
      collected: 0,
      pending: 0,
      orderValue: 0,
    };
    if (e.paymentStatus === "COLLECTED") dEnt.collected += e.paidAmount;
    else if (e.paymentStatus === "PENDING") dEnt.pending += e.paidAmount;
    byDistrict.set(dKey, dEnt);

    const sKey = e.salesPersonId || e.salesperson || "Unknown";
    const sEnt = bySales.get(sKey) || {
      id: e.salesPersonId || "",
      name: e.salesperson || "Unknown",
      collected: 0,
      pending: 0,
      orders: 0,
    };
    if (e.paymentStatus === "COLLECTED") sEnt.collected += e.paidAmount;
    else if (e.paymentStatus === "PENDING") sEnt.pending += e.paidAmount;
    sEnt.orders += 1;
    bySales.set(sKey, sEnt);

    const st = e.paymentStatus || "UNKNOWN";
    const stEnt = byPaymentStatus.get(st) || { status: st, count: 0, collected: 0 };
    stEnt.count += 1;
    stEnt.collected += e.paidAmount;
    byPaymentStatus.set(st, stEnt);
  }

  return {
    byDistrict: [...byDistrict.values()]
      .sort((a, b) => b.collected - a.collected)
      .slice(0, 20),
    bySalesperson: [...bySales.values()]
      .sort((a, b) => b.collected - a.collected)
      .slice(0, 20),
    byOrderStatus: [...byPaymentStatus.values()].sort((a, b) => b.count - a.count),
    byPaymentBucket: [
      {
        label: "Advance (COLLECTED pre-dispatch)",
        count: entries.filter((e) => e.isAdvance).length,
        amount: entries.filter((e) => e.isAdvance).reduce((s, e) => s + e.paidAmount, 0),
      },
    ],
  };
}

function applyRoleMatch(pipeline, user) {
  if (!user) return;
  const { jobTitle, _id: userId } = user;
  if (jobTitle === "SALES") {
    pipeline.push({ $match: { salesPerson: userId } });
  } else if (jobTitle === "DEALER") {
    pipeline.push({
      $match: { $or: [{ dealer: userId }, { salesPerson: userId }] },
    });
  }
}

function orderHasAdvancePayment(order) {
  return (order.payments || []).some(
    (p) => resolvePaymentTiming(p, order.firstDispatchAt) === "advance"
  );
}

function parseCommaList(val) {
  if (val == null || val === "" || val === "all") return [];
  const raw = Array.isArray(val) ? val : String(val).split(",");
  return raw.map((s) => String(s).trim()).filter(Boolean);
}

function paymentBucketMatch(bucket, order) {
  const b = String(bucket || "all").toLowerCase();
  const { collected, pending, totalAmount } = order;
  if (b === "all") return true;
  if (b === "advance") return orderHasAdvancePayment(order);
  if (b === "has_collected") return collected > 0;
  if (b === "has_pending") return pending > 0;
  if (b === "fully_paid") return totalAmount > 0 && collected >= totalAmount;
  if (b === "partial") return collected > 0 && collected < totalAmount;
  if (b === "unpaid") return collected <= 0;
  return true;
}

function paymentBucketsMatch(buckets, order) {
  const list = parseCommaList(buckets).map((b) => b.toLowerCase());
  if (!list.length) return true;
  return list.some((b) => paymentBucketMatch(b, order));
}


function buildSeries(orders) {
  const byDistrict = new Map();
  const bySales = new Map();
  const byOrderStatus = new Map();
  let fullyPaid = 0;
  let partial = 0;
  let unpaid = 0;

  for (const o of orders) {
    const dKey = o.district || "Unknown";
    const dEnt = byDistrict.get(dKey) || {
      name: dKey,
      collected: 0,
      pending: 0,
      orderValue: 0,
    };
    dEnt.collected += o.collected;
    dEnt.pending += o.pending;
    dEnt.orderValue += o.totalAmount;
    byDistrict.set(dKey, dEnt);

    const sKey = o.salesPersonId || o.salesperson || "Unknown";
    const sEnt = bySales.get(sKey) || {
      id: o.salesPersonId || "",
      name: o.salesperson || "Unknown",
      collected: 0,
      pending: 0,
      orders: 0,
    };
    sEnt.collected += o.collected;
    sEnt.pending += o.pending;
    sEnt.orders += 1;
    bySales.set(sKey, sEnt);

    const st = o.rawOrderStatus || "UNKNOWN";
    const stEnt = byOrderStatus.get(st) || { status: st, count: 0, collected: 0 };
    stEnt.count += 1;
    stEnt.collected += o.collected;
    byOrderStatus.set(st, stEnt);

    if (o.totalAmount > 0 && o.collected >= o.totalAmount) fullyPaid += 1;
    else if (o.collected > 0) partial += 1;
    else unpaid += 1;
  }

  return {
    byDistrict: [...byDistrict.values()]
      .sort((a, b) => b.collected - a.collected)
      .slice(0, 20),
    bySalesperson: [...bySales.values()]
      .sort((a, b) => b.collected - a.collected)
      .slice(0, 20),
    byOrderStatus: [...byOrderStatus.values()].sort((a, b) => b.count - a.count),
    byPaymentBucket: [
      { label: "Fully paid", count: fullyPaid, amount: 0 },
      { label: "Partial", count: partial, amount: 0 },
      { label: "Unpaid", count: unpaid, amount: 0 },
    ],
  };
}

function buildFilterOptions(rows) {
  const districts = new Set();
  const talukas = new Set();
  const villages = new Set();
  const sales = new Map();

  for (const r of rows) {
    if (r.district) districts.add(r.district);
    if (r.taluka) talukas.add(r.taluka);
    if (r.village) villages.add(r.village);
    const sid = r.salesPersonId || "";
    if (sid) {
      sales.set(sid, r.salesperson || sid);
    }
  }

  return {
    districts: [...districts].sort(),
    talukas: [...talukas].sort(),
    villages: [...villages].sort(),
    salespeople: [...sales.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function computeStats(orders) {
  let totalPlants = 0;
  let totalOrderValue = 0;
  let totalCollected = 0;
  let totalPending = 0;
  let fullyPaidCount = 0;
  let partialCount = 0;
  let unpaidCount = 0;
  let ordersWithPendingPayments = 0;
  let ordersWithCollected = 0;

  for (const o of orders) {
    totalPlants += o.qty || 0;
    totalOrderValue += o.totalAmount || 0;
    totalCollected += o.collected || 0;
    totalPending += o.pending || 0;
    if (o.pending > 0) ordersWithPendingPayments += 1;
    if (o.collected > 0) ordersWithCollected += 1;
    if (o.totalAmount > 0 && o.collected >= o.totalAmount) fullyPaidCount += 1;
    else if (o.collected > 0) partialCount += 1;
    else unpaidCount += 1;
  }

  return {
    orderCount: orders.length,
    totalPlants,
    totalOrderValue: Math.round(totalOrderValue),
    totalCollected: Math.round(totalCollected),
    totalPending: Math.round(totalPending),
    totalBalance: Math.round(Math.max(0, totalOrderValue - totalCollected)),
    fullyPaidCount,
    partialCount,
    unpaidCount,
    ordersWithPendingPayments,
    ordersWithCollected,
    paymentEntryCount: 0,
    totalAdvanceAmount: 0,
    uniqueOrderCount: orders.length,
  };
}

export const getCollectionsOverview = catchAsync(async (req, res) => {
  const {
    startDate,
    endDate,
    dateField: dateFieldParam,
    dateRangeField,
    plantId,
    subtypeId,
    varietyName,
    district,
    taluka,
    village,
    salesPersonId,
    salesPersonIds,
    orderStatus,
    paymentBucket = "all",
    paymentBuckets,
    paymentStatus,
    paymentStatuses,
    paymentTypes,
    advanceOnly: advanceOnlyParam,
    excludeTestFarmers = "true",
    source: dataSourceParam,
  } = req.query;

  const bucketList = parseCommaList(paymentBuckets || paymentBucket)
    .map((b) => b.toLowerCase())
    .filter((b) => b !== "advance");
  const paymentStatusList = parseCommaList(paymentStatuses || paymentStatus).map((s) =>
    s.toUpperCase()
  );
  const paymentTypeList = parseCommaList(paymentTypes).map((t) => t.toLowerCase());
  const salesIdList = parseCommaList(salesPersonIds || salesPersonId);
  const talukaList = parseCommaList(taluka);
  const villageList = parseCommaList(village);

  const paymentEntryView =
    String(advanceOnlyParam) === "true" || paymentTypeList.length > 0;
  const advanceOnly =
    paymentEntryView &&
    (String(advanceOnlyParam) === "true" ||
      (paymentTypeList.length === 1 && paymentTypeList[0] === "advance"));

  if (!startDate || !endDate) {
    return res.status(400).json({
      success: false,
      message: "startDate and endDate are required (DD-MM-YYYY)",
    });
  }

  /** dateRangeField is whitelisted on older prod; dateField on newer deploys. */
  const dateField = dateFieldParam || dateRangeField || "booking";
  const useDelivery = String(dateField).toLowerCase() === "delivery";
  const reportDateStr = istCalendarDateString(new Date());
  const reportDateIso = `${reportDateStr}T12:00:00.000Z`;

  const plantDocs = await PlantCms.find({})
    .select({ name: 1, subtypes: 1 })
    .lean();

  const plants = plantDocs.map((p) => {
    const firstSubtype = p.subtypes?.[0];
    return {
      id: String(p._id),
      name: p.name,
      nameMr: p.name,
      variety: firstSubtype?.name || "",
    };
  });

  const plantVarieties = {};
  for (const p of plantDocs) {
    plantVarieties[String(p._id)] = (p.subtypes || [])
      .map((s) => s.name)
      .filter(Boolean);
  }

  const pipeline = [];
  applyRoleMatch(pipeline, req.user);

  const dateRange = {
    $gte: parseDate(startDate),
    $lte: parseDate(endDate, true),
  };

  const matchStage = {
    dealerOrder: false,
    farmer: { $exists: true, $ne: null },
    orderStatus: { $nin: EXCLUDED_ORDER_STATUSES },
  };

  if (useDelivery) {
    matchStage.deliveryDate = { ...dateRange, $ne: null };
  } else {
    matchStage.orderBookingDate = dateRange;
  }

  if (plantId && mongoose.Types.ObjectId.isValid(plantId)) {
    matchStage.plantName = new mongoose.Types.ObjectId(plantId);
  }
  if (subtypeId && subtypeId !== "general" && mongoose.Types.ObjectId.isValid(subtypeId)) {
    matchStage.plantSubtype = new mongoose.Types.ObjectId(subtypeId);
  } else if (
    plantId &&
    varietyName &&
    String(varietyName).trim() &&
    mongoose.Types.ObjectId.isValid(plantId)
  ) {
    const cms = await PlantCms.findById(plantId).select("subtypes").lean();
    const st = (cms?.subtypes || []).find(
      (s) => s.name?.trim() === String(varietyName).trim()
    );
    if (st?._id) {
      matchStage.plantSubtype = st._id;
    }
  }

  if (salesIdList.length === 1 && mongoose.Types.ObjectId.isValid(salesIdList[0])) {
    matchStage.salesPerson = new mongoose.Types.ObjectId(salesIdList[0]);
  } else if (salesIdList.length > 1) {
    const oids = salesIdList
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));
    if (oids.length) matchStage.salesPerson = { $in: oids };
  }

  if (orderStatus && String(orderStatus).trim()) {
    const statuses = String(orderStatus)
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (statuses.length) {
      matchStage.orderStatus = { $in: statuses };
    }
  }

  pipeline.push({ $match: matchStage });
  pipeline.push({ $sort: useDelivery ? { deliveryDate: -1 } : { orderBookingDate: -1 } });
  pipeline.push({ $limit: 10000 });

  pipeline.push({
    $lookup: {
      from: "farmers",
      localField: "farmer",
      foreignField: "_id",
      pipeline: [
        {
          $project: {
            _id: 0,
            name: 1,
            village: 1,
            taluka: 1,
            talukaName: 1,
            district: 1,
            districtName: 1,
            mobileNumber: 1,
          },
        },
      ],
      as: "farmerData",
    },
  });

  pipeline.push({
    $lookup: {
      from: "users",
      localField: "salesPerson",
      foreignField: "_id",
      pipeline: [{ $project: { _id: 0, name: 1 } }],
      as: "salesData",
    },
  });

  pipeline.push({
    $lookup: {
      from: "plantcms",
      localField: "plantName",
      foreignField: "_id",
      pipeline: [{ $project: { name: 1, subtypes: 1 } }],
      as: "plantData",
    },
  });

  pipeline.push({
    $addFields: {
      varietyDoc: {
        $arrayElemAt: [
          {
            $filter: {
              input: { $ifNull: [{ $arrayElemAt: ["$plantData.subtypes", 0] }, []] },
              as: "st",
              cond: { $eq: ["$$st._id", "$plantSubtype"] },
            },
          },
          0,
        ],
      },
      qty: {
        $add: [{ $ifNull: ["$numberOfPlants", 0] }, { $ifNull: ["$additionalPlants", 0] }],
      },
      farmerDistrict: {
        $ifNull: [
          { $arrayElemAt: ["$farmerData.districtName", 0] },
          { $arrayElemAt: ["$farmerData.district", 0] },
        ],
      },
      farmerTaluka: {
        $ifNull: [
          { $arrayElemAt: ["$farmerData.talukaName", 0] },
          { $arrayElemAt: ["$farmerData.taluka", 0] },
        ],
      },
      farmerVillage: { $arrayElemAt: ["$farmerData.village", 0] },
      farmerName: { $arrayElemAt: ["$farmerData.name", 0] },
      farmerMobile: { $arrayElemAt: ["$farmerData.mobileNumber", 0] },
      salesperson: { $arrayElemAt: ["$salesData.name", 0] },
    },
  });

  const geoMatch = {};
  if (district && String(district).trim() && district !== "all") {
    geoMatch.farmerDistrict = String(district).trim();
  }
  if (talukaList.length === 1) {
    geoMatch.farmerTaluka = talukaList[0];
  } else if (talukaList.length > 1) {
    geoMatch.farmerTaluka = { $in: talukaList };
  }
  if (villageList.length === 1) {
    geoMatch.farmerVillage = villageList[0];
  } else if (villageList.length > 1) {
    geoMatch.farmerVillage = { $in: villageList };
  }
  if (Object.keys(geoMatch).length) {
    pipeline.push({ $match: geoMatch });
  }

  pipeline.push({
    $project: {
      orderId: 1,
      orderStatus: 1,
      orderPaymentStatus: 1,
      rate: 1,
      qty: 1,
      orderBookingDate: 1,
      deliveryDate: 1,
      payment: 1,
      dispatchHistory: 1,
      statusChanges: 1,
      dispatchTargetDate: 1,
      orderRemarks: 1,
      notes: 1,
      varietyName: "$varietyDoc.name",
      plantNameId: "$plantName",
      farmerName: 1,
      farmerMobile: 1,
      salesperson: 1,
      salesPersonIdStr: { $toString: "$salesPerson" },
      farmerDistrict: 1,
      farmerTaluka: 1,
      farmerVillage: 1,
    },
  });

  const rawRows = await Order.aggregate(pipeline).allowDiskUse(true);
  const skipTest = String(excludeTestFarmers) !== "false";

  const mappedPreBucket = [];
  for (const row of rawRows) {
    if (skipTest) {
      const mobileNorm = normalizeFarmerMobile(row.farmerMobile);
      if (mobileNorm && EXCLUDED_FARMER_MOBILES.has(mobileNorm)) continue;
    }

    const qty = row.qty || 0;
    const rate = row.rate || 0;
    const totalAmount = qty * rate;
    const collected = sumByPaymentStatus(row.payment, "COLLECTED");
    const pending = sumByPaymentStatus(row.payment, "PENDING");
    const balance = Math.max(0, totalAmount - collected);
    const advancePercent =
      totalAmount > 0 ? Math.min(100, Math.round((collected / totalAmount) * 100)) : 0;
    const dispatchAt = firstDispatchAt(row);

    mappedPreBucket.push({
      orderId: row.orderId,
      farmerMobile: row.farmerMobile != null ? String(row.farmerMobile) : "",
      farmerName: row.farmerName || "",
      district: row.farmerDistrict || "",
      taluka: row.farmerTaluka || "",
      village: row.farmerVillage || "",
      salesperson: row.salesperson || "",
      salesPersonId: row.salesPersonIdStr ? String(row.salesPersonIdStr) : "",
      plantId: String(row.plantNameId),
      variety: row.varietyName || "",
      qty,
      rate,
      totalAmount: Math.round(totalAmount),
      collected: Math.round(collected),
      pending: Math.round(pending),
      balance: Math.round(balance),
      advancePercent,
      orderPaymentStatus: row.orderPaymentStatus || "PENDING",
      rawOrderStatus: row.orderStatus || "",
      statusUi: mapOrderStatusToUi(row.orderStatus),
      createdAt: row.orderBookingDate
        ? new Date(row.orderBookingDate).toISOString()
        : null,
      deliveryDate: row.deliveryDate ? new Date(row.deliveryDate).toISOString() : null,
      firstDispatchAt: dispatchAt ? dispatchAt.toISOString() : null,
      payments: mapPaymentLines(row.payment),
      orderRemarks: Array.isArray(row.orderRemarks) ? row.orderRemarks : [],
      notes: row.notes || "",
    });
  }

  const filterOptions = buildFilterOptions(mappedPreBucket);

  let orders = mappedPreBucket.filter((o) =>
    paymentBucketsMatch(bucketList.length ? bucketList.join(",") : paymentBucket, o)
  );
  if (paymentTypeList.length || paymentStatusList.length) {
    orders = orders.filter((o) =>
      orderMatchesPaymentFilters(o, paymentTypeList, paymentStatusList)
    );
  }

  let paymentEntries = flattenPaymentEntries(orders, {
    paymentTypes: paymentTypeList,
    paymentStatuses: paymentStatusList,
    advanceOnly: advanceOnly && !paymentTypeList.length,
  });

  const stats = paymentEntryView
    ? computeStatsFromEntries(paymentEntries, orders, advanceOnly)
    : computeStats(orders);
  if (!paymentEntryView && paymentEntries.length) {
    stats.paymentEntryCount = paymentEntries.length;
    stats.totalAdvanceAmount = Math.round(
      paymentEntries.filter((e) => e.isAdvance).reduce((s, e) => s + e.paidAmount, 0)
    );
  }

  const series = paymentEntryView
    ? buildSeriesFromEntries(paymentEntries)
    : buildSeries(orders);

  let ordersOut = orders;
  const useLedgerSource = String(dataSourceParam || "").toLowerCase() === "ledger";
  let ledgerMeta = {};
  if (useLedgerSource) {
    try {
      const ledgerReports = await import(
        "../modules/finance/reports/orderCollectionsFromLedger.js"
      );
      ordersOut = await ledgerReports.applyLedgerBalancesToOrders(orders);
      const rangeStart = parseDate(startDate);
      const rangeEnd = parseDate(endDate, true);
      ledgerMeta = {
        dataSource: "ledger",
        ledgerCollectedInRange: await ledgerReports.getLedgerCollectedTotalForDateRange(
          rangeStart,
          rangeEnd
        ),
      };
    } catch (ledgerErr) {
      console.error("[Finance] collections ledger source:", ledgerErr?.message || ledgerErr);
      ledgerMeta = { dataSource: "ledger", ledgerError: String(ledgerErr?.message || ledgerErr) };
    }
  }

  return res.status(200).json({
    success: true,
    data: {
      reportDate: reportDateIso,
      reportDateCalendar: reportDateStr,
      plants,
      plantVarieties,
      stats: { ...stats, ...ledgerMeta },
      filterOptions,
      series,
      orders: ordersOut,
      paymentEntries,
      meta: {
        orderCount: ordersOut.length,
        paymentEntryCount: paymentEntries.length,
        rawCount: rawRows.length,
        cappedAt: rawRows.length >= 10000 ? 10000 : null,
        dateField: useDelivery ? "delivery" : "booking",
        viewMode: paymentEntryView ? "payments" : "orders",
        advanceOnly: paymentEntryView,
        paymentTypes: paymentTypeList,
        ...ledgerMeta,
      },
    },
  });
});
