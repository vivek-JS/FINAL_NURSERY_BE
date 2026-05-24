import mongoose from "mongoose";
import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";
import DealerCommissionRate from "../models/dealerCommissionRate.model.js";
import DealerCommissionSettlement from "../models/dealerCommissionSettlement.model.js";

export const DEFAULT_COMMISSION_RATE = 1;

const EXCLUDED_STATUSES = new Set([
  "REJECTED",
  "CANCELLED",
  "TEMPORARY_CANCELLED",
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
  return Math.max(0, total - remaining);
}

export function getCollectedPayment(order) {
  return (order.payment || []).reduce(
    (sum, p) =>
      p?.paymentStatus === "COLLECTED" ? sum + Number(p.paidAmount || 0) : sum,
    0
  );
}

export function resolveOrderVillage(order) {
  const farmer = order.farmer && typeof order.farmer === "object" ? order.farmer : null;
  const orderFor =
    order.orderFor && typeof order.orderFor === "object" ? order.orderFor : null;
  return (
    String(orderFor?.village || farmer?.village || "Unknown village").trim() ||
    "Unknown village"
  );
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

export function computeOrderCommissionMetrics(order, ratesMap, plantNames, subtypeNames) {
  const plantId = order.plantName?.toString?.() ?? String(order.plantName || "");
  const subtypeId =
    order.plantSubtype?.toString?.() ?? String(order.plantSubtype || "");
  const rate = getCommissionRateForOrder(order, ratesMap);
  const totalPlants = getOrderTotalPlants(order);
  const dispatchedQty = getDispatchedQty(order);
  const baki = Math.max(0, totalPlants - dispatchedQty);
  const collected = getCollectedPayment(order);
  const orderTotalValue = totalPlants * Number(order.rate || 0);

  let expected = 0;
  const booked = totalPlants;
  if (order.orderStatus === "ACCEPTED") {
    expected = totalPlants * rate;
  }

  let actual = 0;
  if (dispatchedQty > 0) {
    const base = dispatchedQty * rate;
    if (collected <= 0) actual = -base;
    else actual = base;
  }

  return {
    orderId: order.orderId || order._id,
    orderMongoId: order._id,
    status: order.orderStatus,
    farmerName:
      order.orderFor?.name ||
      (order.farmer && typeof order.farmer === "object" ? order.farmer.name : "") ||
      "—",
    village: resolveOrderVillage(order),
    plantId,
    subtypeId,
    plantName: plantNames.get(plantId) || plantId,
    subtypeName: subtypeNames.get(subtypeId) || subtypeId,
    ratePerPlant: rate,
    booked,
    baki,
    dispatched: dispatchedQty,
    totalPlants,
    expectedCommission: expected,
    actualCommission: actual,
    paymentCollected: collected,
    orderTotalValue,
    paymentDue: Math.max(0, orderTotalValue - collected),
  };
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
        ],
      },
    ];
  }

  return Order.find(query)
    .select(
      "orderId orderStatus numberOfPlants additionalPlants remainingPlants plantName plantSubtype rate payment dispatchHistory orderFor farmer createdAt orderBookingDate"
    )
    .populate("farmer", "name village")
    .sort({ createdAt: -1 })
    .lean();
}

export async function buildDealerCommissionAnalysis(dealerId, options = {}) {
  const { startDate, endDate } = options;
  const [orders, ratesMap, plants] = await Promise.all([
    fetchDealerOrders(dealerId, { startDate, endDate }),
    loadCommissionRatesMap(),
    PlantCms.find({}).select("name subtypes").lean(),
  ]);

  const { plantNames, subtypeNames } = buildPlantSubtypeMaps(plants);

  const summary = {
    expectedCommission: 0,
    actualCommission: 0,
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
      subtypeNames
    );
    orderRows.push(metrics);

    summary.expectedCommission += metrics.expectedCommission;
    summary.actualCommission += metrics.actualCommission;
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
        subtypes: new Map(),
      });
    }
    const plantAgg = plantMap.get(plantKey);
    plantAgg.booked += metrics.booked;
    plantAgg.baki += metrics.baki;
    plantAgg.dispatched += metrics.dispatched;
    plantAgg.expectedCommission += metrics.expectedCommission;
    plantAgg.actualCommission += metrics.actualCommission;

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
      });
    }
    const stAgg = plantAgg.subtypes.get(stKey);
    stAgg.booked += metrics.booked;
    stAgg.baki += metrics.baki;
    stAgg.dispatched += metrics.dispatched;
    stAgg.expectedCommission += metrics.expectedCommission;
    stAgg.actualCommission += metrics.actualCommission;

    const villageKey = metrics.village;
    if (!villageMap.has(villageKey)) {
      villageMap.set(villageKey, {
        village: villageKey,
        booked: 0,
        baki: 0,
        dispatched: 0,
        expectedCommission: 0,
        actualCommission: 0,
        orderCount: 0,
      });
    }
    const villageAgg = villageMap.get(villageKey);
    villageAgg.booked += metrics.booked;
    villageAgg.baki += metrics.baki;
    villageAgg.dispatched += metrics.dispatched;
    villageAgg.expectedCommission += metrics.expectedCommission;
    villageAgg.actualCommission += metrics.actualCommission;
    villageAgg.orderCount += 1;
  }

  summary.gap = summary.expectedCommission - summary.actualCommission;

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

  return {
    dealerId,
    period: { startDate: startDate || null, endDate: endDate || null },
    summary,
    byPlantType,
    byVillage,
    orders: orderRows,
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
