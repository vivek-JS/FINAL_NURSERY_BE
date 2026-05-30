import mongoose from "mongoose";
import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";
import CMS from "../models/cms.model.js";
import DealerCommissionRate from "../models/dealerCommissionRate.model.js";
import DealerCommissionSettlement from "../models/dealerCommissionSettlement.model.js";

export const DEFAULT_COMMISSION_RATE = 1;

const EXCLUDED_STATUSES = new Set([
  "REJECTED",
  "CANCELLED",
  "TEMPORARY_CANCELLED",
]);

export const EXPECTED_COMMISSION_STATUSES = new Set([
  "ACCEPTED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "DISPATCHED",
  "PARTIALLY_COMPLETED",
  "COMPLETED",
]);

/** Earned/at-risk commission: dispatched (or completed) plants, adjusted by payment. */
export const ACTUAL_COMMISSION_STATUSES = new Set([
  "DISPATCHED",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
]);

export function isPapayaCommissionException(plantName, subtypeName) {
  if (!plantName || !/papaya/i.test(String(plantName))) return false;
  const st = String(subtypeName || "").trim();
  return /^15\s*NOA$/i.test(st) || /^15\s*R15$/i.test(st);
}

export function getOrderTotalPlants(order) {
  return (order.numberOfPlants || 0) + (order.additionalPlants || 0);
}

export function getDispatchedQty(order) {
  const total = getOrderTotalPlants(order);
  const historyQty = (order.dispatchHistory || []).reduce(
    (sum, row) => sum + Number(row.quantity || 0),
    0
  );
  if (historyQty > 0) return historyQty;
  const remaining = order.remainingPlants ?? total;
  let dispatched = Math.max(0, total - remaining);
  // Completed in prod without dispatchHistory / remainingPlants not zeroed
  if (
    dispatched === 0 &&
    ACTUAL_COMMISSION_STATUSES.has(order.orderStatus) &&
    total > 0
  ) {
    dispatched = total;
  }
  return dispatched;
}

export function getFinalPlants(order) {
  const total = getOrderTotalPlants(order);
  const dispatched = getDispatchedQty(order);
  const returned = Number(order.returnedPlants || 0);
  const damaged = Number(order.damagedPlants || 0);
  let finalPlants = Math.max(0, dispatched - returned - damaged);
  if (
    finalPlants === 0 &&
    ACTUAL_COMMISSION_STATUSES.has(order.orderStatus) &&
    total > 0
  ) {
    finalPlants = Math.max(0, total - returned - damaged);
  }
  return finalPlants;
}

export function getCollectedPayment(order) {
  return (order.payment || []).reduce(
    (sum, p) =>
      p?.paymentStatus === "COLLECTED" ? sum + Number(p.paidAmount || 0) : sum,
    0
  );
}

/** CMS village id/name → display label for analytics grouping. */
export async function loadVillageDisplayMap() {
  const rows = await CMS.find({ type: "village" }).select("data").lean();
  const map = new Map();
  for (const row of rows) {
    const name = String(row.data || "").trim();
    if (!name) continue;
    map.set(name, name);
    map.set(row._id.toString(), name);
  }
  return map;
}

function resolveVillageRaw(order) {
  const farmer = order.farmer && typeof order.farmer === "object" ? order.farmer : null;
  const orderFor =
    order.orderFor && typeof order.orderFor === "object" ? order.orderFor : null;
  return (
    String(orderFor?.villageName || orderFor?.village || "").trim() ||
    String(farmer?.village || "").trim() ||
    ""
  );
}

export function resolveOrderVillage(order, villageDisplayMap = null) {
  const raw = resolveVillageRaw(order);
  if (!raw) return "Unknown village";
  const mapped = villageDisplayMap?.get(raw);
  if (mapped) return mapped;
  if (/^[a-f0-9]{24}$/i.test(raw)) return "Unknown village";
  return raw;
}

export async function loadCommissionRatesMap() {
  const rates = await DealerCommissionRate.find({ isActive: true }).lean();
  const map = new Map();
  for (const row of rates) {
    const plantId = row.plantId?.toString?.() ?? String(row.plantId);
    const subtypeId = row.subtypeId?.toString?.() ?? String(row.subtypeId);
    map.set(`${plantId}_${subtypeId}`, Number(row.ratePerPlant ?? DEFAULT_COMMISSION_RATE));
  }
  return map;
}

export function getCommissionRateForOrder(order, ratesMap) {
  const plantId = order.plantName?.toString?.() ?? String(order.plantName || "");
  const subtypeId =
    order.plantSubtype?.toString?.() ?? String(order.plantSubtype || "");
  return ratesMap.get(`${plantId}_${subtypeId}`) ?? DEFAULT_COMMISSION_RATE;
}

/** Split order actual commission into earned (paid) vs at-risk (dispatched, payment pending). */
export function splitCommissionAmount(actualCommission) {
  const n = Number(actualCommission || 0);
  if (n > 0) return { earnedCommission: n, atRiskCommission: 0 };
  if (n < 0) return { earnedCommission: 0, atRiskCommission: Math.abs(n) };
  return { earnedCommission: 0, atRiskCommission: 0 };
}

function addCommissionToAgg(agg, metrics) {
  const actual = Number(metrics.actualCommission || 0);
  agg.actualCommission += actual;
  agg.earnedCommission += Number(metrics.earnedCommission || 0);
  agg.atRiskCommission += Number(metrics.atRiskCommission || 0);
}

export function computeOrderCommissionMetrics(
  order,
  ratesMap,
  plantNames,
  subtypeNames,
  options = {}
) {
  const plantId = order.plantName?.toString?.() ?? String(order.plantName || "");
  const subtypeId =
    order.plantSubtype?.toString?.() ?? String(order.plantSubtype || "");
  const rate = getCommissionRateForOrder(order, ratesMap);
  const totalPlants = getOrderTotalPlants(order);
  const dispatchedQty = getDispatchedQty(order);
  const baki = Math.max(0, totalPlants - dispatchedQty);
  const collected = getCollectedPayment(order);
  const orderTotalValue = totalPlants * Number(order.rate || 0);
  const finalPlants = getFinalPlants(order);

  let expected = 0;
  const booked = totalPlants;
  if (EXPECTED_COMMISSION_STATUSES.has(order.orderStatus)) {
    expected = totalPlants * rate;
  }

  let actual = 0;
  let paymentRatio = 0;
  let baseCommission = 0;
  let unpaidLiability = 0;
  const paymentDue = Math.max(0, orderTotalValue - collected);
  const isPaymentComplete =
    orderTotalValue <= 0 ||
    paymentDue <= 0 ||
    order.orderPaymentStatus === "COMPLETED" ||
    order.paymentCompleted === true;

  if (ACTUAL_COMMISSION_STATUSES.has(order.orderStatus) && finalPlants > 0) {
    baseCommission = finalPlants * rate;
    paymentRatio =
      orderTotalValue > 0 ? Math.min(1, collected / orderTotalValue) : 1;
    if (isPaymentComplete) {
      actual = baseCommission;
      unpaidLiability = 0;
    } else {
      unpaidLiability = baseCommission;
      actual = -baseCommission;
    }
  }

  const { earnedCommission, atRiskCommission } = splitCommissionAmount(actual);

  return {
    orderId: order.orderId || order._id,
    orderMongoId: order._id,
    status: order.orderStatus,
    farmerName:
      order.orderFor?.name ||
      (order.farmer && typeof order.farmer === "object" ? order.farmer.name : "") ||
      "—",
    village: resolveOrderVillage(order, options.villageDisplayMap),
    plantId,
    subtypeId,
    plantName: plantNames.get(plantId) || plantId,
    subtypeName: subtypeNames.get(subtypeId) || subtypeId,
    ratePerPlant: rate,
    booked,
    baki,
    dispatched: dispatchedQty,
    finalPlants,
    totalPlants,
    expectedCommission: expected,
    actualCommission: actual,
    earnedCommission,
    atRiskCommission,
    baseCommission,
    unpaidLiability,
    paymentCollected: collected,
    paymentRatio,
    orderTotalValue,
    paymentDue,
    paymentPending: paymentDue,
    isPaymentComplete,
  };
}

const COMMISSION_IMPACT_SORT_FIELDS = new Set([
  "paymentPending",
  "actualCommission",
  "paymentCollected",
  "finalPlants",
]);

function mapCommissionImpactOrder(o) {
  return {
    orderId: o.orderId,
    orderMongoId: o.orderMongoId,
    farmerName: o.farmerName,
    village: o.village,
    plantName: o.plantName,
    subtypeName: o.subtypeName,
    status: o.status,
    totalPlants: o.totalPlants,
    finalPlants: o.finalPlants,
    paymentCollected: o.paymentCollected,
    paymentPending: o.paymentPending ?? o.paymentDue ?? 0,
    orderTotalValue: o.orderTotalValue,
    actualCommission: o.actualCommission,
    baseCommission: o.baseCommission,
    ratePerPlant: o.ratePerPlant,
    isPaymentComplete: o.isPaymentComplete,
  };
}

export function buildCommissionImpactOrders(
  orderRows,
  { impact = "negative", sortBy = "paymentPending", sortOrder = "desc" } = {}
) {
  const mode = impact === "positive" ? "positive" : "negative";
  const defaultSort = mode === "positive" ? "actualCommission" : "paymentPending";
  const field = COMMISSION_IMPACT_SORT_FIELDS.has(sortBy) ? sortBy : defaultSort;
  const desc = sortOrder !== "asc";

  const rows = orderRows.filter((o) => {
    const actual = Number(o.actualCommission || 0);
    return mode === "positive" ? actual > 0 : actual < 0;
  });

  rows.sort((a, b) => {
    const av = Number(a[field] ?? 0);
    const bv = Number(b[field] ?? 0);
    if (field === "actualCommission") {
      if (mode === "negative") {
        return desc ? av - bv : bv - av;
      }
      return desc ? bv - av : av - bv;
    }
    return desc ? bv - av : av - bv;
  });

  return rows.map(mapCommissionImpactOrder);
}

export function buildNegativeActualOrders(orderRows, options = {}) {
  return buildCommissionImpactOrders(orderRows, { ...options, impact: "negative" });
}

export function buildPositiveActualOrders(orderRows, options = {}) {
  return buildCommissionImpactOrders(orderRows, {
    sortBy: "actualCommission",
    sortOrder: "desc",
    ...options,
    impact: "positive",
  });
}

export function summarizeCommissionImpactOrders(orders, impact = "negative") {
  if (impact === "positive") {
    return {
      count: orders.length,
      totalPositiveCommission: orders.reduce((s, o) => s + Number(o.actualCommission || 0), 0),
      totalPaymentCollected: orders.reduce((s, o) => s + Number(o.paymentCollected || 0), 0),
    };
  }
  return {
    count: orders.length,
    totalPaymentPending: orders.reduce((s, o) => s + Number(o.paymentPending || 0), 0),
    totalNegativeCommission: orders.reduce((s, o) => s + Number(o.actualCommission || 0), 0),
  };
}

export function summarizeNegativeActualOrders(orders) {
  return summarizeCommissionImpactOrders(orders, "negative");
}

export function summarizePositiveActualOrders(orders) {
  return summarizeCommissionImpactOrders(orders, "positive");
}

function buildPlantSubtypeMaps(plants) {
  const plantNames = new Map();
  const subtypeNames = new Map();
  for (const plant of plants) {
    const pid = plant._id.toString();
    plantNames.set(pid, plant.name);
    for (const st of plant.subtypes || []) {
      subtypeNames.set(st._id.toString(), st.name);
    }
  }
  return { plantNames, subtypeNames };
}

function parseDateRange(startDate, endDate) {
  const filter = {};
  if (startDate) {
    const start = new Date(startDate);
    if (!Number.isNaN(start.getTime())) filter.$gte = start;
  }
  if (endDate) {
    const end = new Date(endDate);
    if (!Number.isNaN(end.getTime())) {
      end.setHours(23, 59, 59, 999);
      filter.$lte = end;
    }
  }
  return Object.keys(filter).length ? filter : null;
}

export async function fetchDealerOrders(dealerId, { startDate, endDate } = {}) {
  const oid = new mongoose.Types.ObjectId(dealerId);
  const query = {
    $or: [{ dealer: oid }, { salesPerson: oid }],
    orderStatus: { $nin: Array.from(EXCLUDED_STATUSES) },
  };

  const dateFilter = parseDateRange(startDate, endDate);
  if (dateFilter) {
    query.$and = [
      {
        $or: [
          { orderBookingDate: dateFilter },
          { createdAt: dateFilter },
          { updatedAt: dateFilter },
        ],
      },
    ];
  }

  return Order.find(query)
    .select(
      "orderId orderStatus orderPaymentStatus paymentCompleted numberOfPlants additionalPlants remainingPlants returnedPlants damagedPlants plantName plantSubtype rate payment dispatchHistory orderFor farmer createdAt orderBookingDate"
    )
    .populate("farmer", "name village")
    .sort({ createdAt: -1 })
    .lean();
}

export async function buildDealerCommissionAnalysis(dealerId, options = {}) {
  const { startDate, endDate } = options;
  const [orders, ratesMap, plants, villageDisplayMap] = await Promise.all([
    fetchDealerOrders(dealerId, { startDate, endDate }),
    loadCommissionRatesMap(),
    PlantCms.find({}).select("name subtypes").lean(),
    loadVillageDisplayMap(),
  ]);

  const { plantNames, subtypeNames } = buildPlantSubtypeMaps(plants);

  const summary = {
    expectedCommission: 0,
    actualCommission: 0,
    earnedCommission: 0,
    atRiskCommission: 0,
    gap: 0,
    acceptedOrders: 0,
    bookedPlants: 0,
    dispatchedPlants: 0,
    bakiPlants: 0,
    paymentCollected: 0,
  };

  const plantMap = new Map();
  const villageMap = new Map();
  const orderRows = [];

  for (const order of orders) {
    const metrics = computeOrderCommissionMetrics(
      order,
      ratesMap,
      plantNames,
      subtypeNames,
      { villageDisplayMap }
    );
    orderRows.push(metrics);

    summary.expectedCommission += metrics.expectedCommission;
    addCommissionToAgg(summary, metrics);
    summary.bookedPlants += metrics.booked;
    summary.dispatchedPlants += metrics.dispatched;
    summary.bakiPlants += metrics.baki;
    summary.paymentCollected += metrics.paymentCollected;
    if (order.orderStatus === "ACCEPTED") summary.acceptedOrders += 1;

    const plantKey = metrics.plantId;
    if (!plantMap.has(plantKey)) {
      plantMap.set(plantKey, {
        plantId: plantKey,
        plantName: metrics.plantName,
        booked: 0,
        baki: 0,
        dispatched: 0,
        expectedCommission: 0,
        actualCommission: 0,
        earnedCommission: 0,
        atRiskCommission: 0,
        subtypes: new Map(),
      });
    }
    const plantAgg = plantMap.get(plantKey);
    plantAgg.booked += metrics.booked;
    plantAgg.baki += metrics.baki;
    plantAgg.dispatched += metrics.dispatched;
    plantAgg.expectedCommission += metrics.expectedCommission;
    addCommissionToAgg(plantAgg, metrics);

    const stKey = metrics.subtypeId;
    if (!plantAgg.subtypes.has(stKey)) {
      plantAgg.subtypes.set(stKey, {
        subtypeId: stKey,
        subtypeName: metrics.subtypeName,
        ratePerPlant: metrics.ratePerPlant,
        booked: 0,
        baki: 0,
        dispatched: 0,
        expectedCommission: 0,
        actualCommission: 0,
        earnedCommission: 0,
        atRiskCommission: 0,
      });
    }
    const stAgg = plantAgg.subtypes.get(stKey);
    stAgg.booked += metrics.booked;
    stAgg.baki += metrics.baki;
    stAgg.dispatched += metrics.dispatched;
    stAgg.expectedCommission += metrics.expectedCommission;
    addCommissionToAgg(stAgg, metrics);

    const villageKey = metrics.village;
    if (!villageMap.has(villageKey)) {
      villageMap.set(villageKey, {
        village: villageKey,
        booked: 0,
        baki: 0,
        dispatched: 0,
        expectedCommission: 0,
        actualCommission: 0,
        earnedCommission: 0,
        atRiskCommission: 0,
        orderCount: 0,
      });
    }
    const villageAgg = villageMap.get(villageKey);
    villageAgg.booked += metrics.booked;
    villageAgg.baki += metrics.baki;
    villageAgg.dispatched += metrics.dispatched;
    villageAgg.expectedCommission += metrics.expectedCommission;
    addCommissionToAgg(villageAgg, metrics);
    villageAgg.orderCount += 1;
  }

  summary.gap = summary.expectedCommission - summary.actualCommission;
  summary.totalPaymentOutstanding = orderRows.reduce(
    (s, o) => s + Number(o.paymentDue ?? o.paymentPending ?? 0),
    0
  );
  summary.totalOrderValue = orderRows.reduce(
    (s, o) => s + Number(o.orderTotalValue || 0),
    0
  );

  const byPlantType = Array.from(plantMap.values())
    .map((p) => ({
      ...p,
      subtypes: Array.from(p.subtypes.values()).sort((a, b) =>
        a.subtypeName.localeCompare(b.subtypeName)
      ),
    }))
    .sort((a, b) => a.plantName.localeCompare(b.plantName));

  const byVillage = Array.from(villageMap.values()).sort(
    (a, b) => b.booked - a.booked
  );

  const negativeActualOrders = buildNegativeActualOrders(orderRows);
  const negativeActualSummary = summarizeNegativeActualOrders(negativeActualOrders);
  const positiveActualOrders = buildPositiveActualOrders(orderRows);
  const positiveActualSummary = summarizePositiveActualOrders(positiveActualOrders);

  return {
    dealerId,
    period: { startDate: startDate || null, endDate: endDate || null },
    summary,
    byPlantType,
    byVillage,
    orders: orderRows,
    negativeActualOrders,
    negativeActualSummary,
    positiveActualOrders,
    positiveActualSummary,
  };
}

export async function sumSettlementsForDealer(dealerId, { startDate, endDate } = {}) {
  const query = { dealer: new mongoose.Types.ObjectId(dealerId) };

  if (startDate || endDate) {
    const { periodStart, periodEnd } = (() => {
      let ps = null;
      let pe = null;
      if (startDate) {
        const start = new Date(startDate);
        if (!Number.isNaN(start.getTime())) ps = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        if (!Number.isNaN(end.getTime())) {
          end.setHours(23, 59, 59, 999);
          pe = end;
        }
      }
      return { periodStart: ps, periodEnd: pe };
    })();

    if (periodStart) query.periodStart = periodStart;
    if (periodEnd) query.periodEnd = periodEnd;
  }

  const rows = await DealerCommissionSettlement.find(query)
    .select("settledAmount amount")
    .lean();
  return rows.reduce((sum, r) => sum + Number(r.settledAmount ?? r.amount ?? 0), 0);
}

export async function computeUnsettledCommission(dealerId, options = {}) {
  const analysis = await buildDealerCommissionAnalysis(dealerId, options);
  const { startDate, endDate } = options;
  const alreadySettled =
    startDate || endDate
      ? await sumSettlementsForDealer(dealerId, { startDate, endDate })
      : await sumSettlementsForDealer(dealerId, {});

  const unsettled = analysis.summary.actualCommission - alreadySettled;
  return {
    ...analysis,
    alreadySettled,
    unsettled,
  };
}

export async function syncCommissionRatesFromPlants(updatedBy = null) {
  const plants = await PlantCms.find({}).select("name subtypes").lean();
  let created = 0;
  let existing = 0;

  for (const plant of plants) {
    for (const subtype of plant.subtypes || []) {
      const filter = {
        plantId: plant._id,
        subtypeId: subtype._id,
      };
      const found = await DealerCommissionRate.findOne(filter);
      if (found) {
        existing += 1;
        continue;
      }
      await DealerCommissionRate.create({
        ...filter,
        plantName: plant.name,
        subtypeName: subtype.name,
        ratePerPlant: DEFAULT_COMMISSION_RATE,
        isActive: true,
        updatedBy,
      });
      created += 1;
    }
  }

  return { created, existing, total: created + existing };
}

export async function bulkDefaultCommissionRates(updatedBy = null) {
  const rates = await DealerCommissionRate.find({}).lean();
  let updated = 0;
  let skipped = 0;

  for (const row of rates) {
    if (isPapayaCommissionException(row.plantName, row.subtypeName)) {
      skipped += 1;
      continue;
    }
    await DealerCommissionRate.updateOne(
      { _id: row._id },
      { $set: { ratePerPlant: DEFAULT_COMMISSION_RATE, updatedBy } }
    );
    updated += 1;
  }

  return { updated, skipped };
}
