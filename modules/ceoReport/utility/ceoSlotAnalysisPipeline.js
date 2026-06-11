import moment from "moment";
import PlantSlot from "../../../models/slots.model.js";
import Order from "../../../models/order.model.js";
import { fetchAvailabilityOverviewData } from "../../../services/whatsappReportAvailability.service.js";
import {
  groupOrdersByDeliverySlot,
  computeSlotDispatchStatsFromOrders,
  getRemainingToDispatchQty,
  getDispatchedAndCompletedQty,
  isSlotStatEligibleOrder,
  NON_DEALER_QUOTA_MATCH,
} from "../../../utility/slotDispatchStats.js";
import { aggregatePastDueMetricsForSlotGroup, isPastDueRolledInOrder } from "../../../utility/pastDueSlotMetrics.js";
import { getIstTodayYmd } from "../../../utility/istOrderDateStats.js";

const IST = "Asia/Kolkata";
const PENDING_STATUSES = new Set(["ACCEPTED", "FARM_READY", "READY_FOR_DISPATCH", "DISPATCH_PROCESS", "PARTIALLY_COMPLETED"]);

function orderPlants(o) {
  return (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0);
}

function slotKey(plantId, subtypeId) {
  return `${plantId}::${subtypeId}`;
}

async function loadSlotFulfillmentMeta(year, plantId) {
  const filter = { year: Number(year) };
  if (plantId) filter.plantId = plantId;
  const docs = await PlantSlot.find(filter).select("plantId subtypeSlots").lean();
  const bySlotId = new Map();
  for (const doc of docs) {
    for (const st of doc.subtypeSlots || []) {
      for (const slot of st.slots || []) {
        if (slot.status === false) continue;
        const id = String(slot._id);
        bySlotId.set(id, {
          plantsSowed: Number(slot.plantsSowed) || 0,
          primarySowed: Number(slot.primarySowed) || 0,
          actualPlants: Number(slot.actualPlants) || 0,
          closingStock: Number(slot.closingStock) || 0,
        });
      }
    }
  }
  return bySlotId;
}

async function loadAnalysisOrders(plantIds, year) {
  const match = {
    ...NON_DEALER_QUOTA_MATCH,
    orderStatus: { $nin: ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"] },
    dealerOrder: { $ne: true },
    deliveryDate: {
      $exists: true,
      $ne: null,
      $gte: new Date(`${year}-01-01T00:00:00+05:30`),
      $lte: new Date(`${year}-12-31T23:59:59.999+05:30`),
    },
  };
  if (plantIds?.length === 1) match.plantName = plantIds[0];
  else if (plantIds?.length > 1) match.plantName = { $in: plantIds };

  return Order.aggregate([
    { $match: match },
    {
      $lookup: {
        from: "farmers",
        localField: "farmer",
        foreignField: "_id",
        pipeline: [{ $project: { village: 1, talukaName: 1, districtName: 1 } }],
        as: "_farmer",
      },
    },
    {
      $addFields: {
        linePlantTotal: {
          $add: [{ $ifNull: ["$numberOfPlants", 0] }, { $ifNull: ["$additionalPlants", 0] }],
        },
        village: { $ifNull: [{ $arrayElemAt: ["$_farmer.village", 0] }, ""] },
        taluka: { $ifNull: [{ $arrayElemAt: ["$_farmer.talukaName", 0] }, ""] },
        district: { $ifNull: [{ $arrayElemAt: ["$_farmer.districtName", 0] }, ""] },
        deliveryChangeCount: { $size: { $ifNull: ["$deliveryChanges", []] } },
      },
    },
  ]);
}

function isPastDueByDate(order, todayYmd) {
  if (!order?.deliveryDate || !PENDING_STATUSES.has(order.orderStatus)) return false;
  const d = new Date(order.deliveryDate).toLocaleDateString("en-CA", { timeZone: IST });
  return d < todayYmd;
}

function filterOrdersInRange(orders, rangeStart, rangeEnd) {
  return orders.filter((o) => {
    const t = new Date(o.deliveryDate).getTime();
    return t >= rangeStart.getTime() && t <= rangeEnd.getTime();
  });
}

function filterDeliveryChangesInRange(orders, rangeStart, rangeEnd) {
  let orderCount = 0;
  let plantCount = 0;
  for (const o of orders) {
    const changes = o.deliveryChanges || [];
    const inRange = changes.some((c) => {
      const t = new Date(c.createdAt || c.updatedAt || 0).getTime();
      return t >= rangeStart.getTime() && t <= rangeEnd.getTime();
    });
    if (inRange || (changes.length > 0 && filterOrdersInRange([o], rangeStart, rangeEnd).length)) {
      if (changes.length > 0) {
        orderCount += 1;
        plantCount += o.linePlantTotal || orderPlants(o);
      }
    }
  }
  return { orders: orderCount, plants: plantCount };
}

function buildDailyLoad(orders, rangeStart, rangeEnd) {
  const todayYmd = getIstTodayYmd();
  const byDay = new Map();
  const start = moment(rangeStart).utcOffset(330).startOf("day");
  const end = moment(rangeEnd).utcOffset(330).startOf("day");
  while (start.isSameOrBefore(end, "day")) {
    const key = start.format("YYYY-MM-DD");
    byDay.set(key, {
      key,
      label: start.format("D MMM"),
      pendingPlants: 0,
      dispatchedPlants: 0,
      orders: 0,
      pastDue: key < todayYmd,
    });
    start.add(1, "day");
  }

  for (const o of orders) {
    if (!isSlotStatEligibleOrder(o) || !o.deliveryDate) continue;
    const key = new Date(o.deliveryDate).toLocaleDateString("en-CA", { timeZone: IST });
    if (!byDay.has(key)) continue;
    const row = byDay.get(key);
    const pending = getRemainingToDispatchQty(o);
    const dispatched = getDispatchedAndCompletedQty(o);
    row.pendingPlants += pending;
    row.dispatchedPlants += dispatched;
    if (pending > 0) row.orders += 1;
  }

  return [...byDay.values()];
}

function buildGeoBreakdown(orders) {
  const talukaMap = new Map();
  const districtMap = new Map();
  for (const o of orders) {
    const pending = getRemainingToDispatchQty(o);
    if (pending <= 0) continue;
    const taluka = o.taluka || "Unknown";
    const district = o.district || "Unknown";
    const t = talukaMap.get(taluka) || { taluka, plants: 0, orders: 0 };
    t.plants += pending;
    t.orders += 1;
    talukaMap.set(taluka, t);
    const d = districtMap.get(district) || { district, plants: 0, orders: 0 };
    d.plants += pending;
    d.orders += 1;
    districtMap.set(district, d);
  }
  const byTaluka = [...talukaMap.values()].sort((a, b) => b.plants - a.plants).slice(0, 12);
  const byDistrict = [...districtMap.values()].sort((a, b) => b.plants - a.plants).slice(0, 10);
  return { byTaluka, byDistrict };
}

function buildSlotRow(row, slotMeta, pipelineOrders, bookedOrders, pastDueGroup, slotId) {
  const meta = slotMeta.get(slotId) || {};
  const dispatchStats = computeSlotDispatchStatsFromOrders([], {
    pipelineOrders,
    bookedOrders,
  });
  const booked = row.bookedPlants || dispatchStats.totalBookedPlants;
  const sowed = meta.plantsSowed || meta.primarySowed || 0;
  const actual = meta.actualPlants || 0;
  const needToProcure = Math.max(0, booked - Math.max(sowed, actual));
  const isCurrent = slotId === pastDueGroup?.currentSlotId;

  return {
    slotId,
    month: row.month,
    startDay: row.startDay,
    endDay: row.endDay,
    label: `${row.startDay} – ${row.endDay}`,
    capacity: {
      totalPlants: row.totalPlants,
      availablePlants: row.availablePlants,
      utilizationPct: row.utilizationPct,
      status: row.status,
    },
    booking: {
      bookedPlants: booked,
      dispatchedPlants: dispatchStats.totalDispatchedPlants,
      remainingToDispatch: dispatchStats.remainingToDispatch,
      remainingNative: dispatchStats.remainingNative,
      remainingRolledIn: dispatchStats.remainingRolledIn,
    },
    fulfillment: {
      plantsSowed: sowed,
      actualPlants: actual,
      closingStock: meta.closingStock || 0,
      needToProcure,
      loadScore: dispatchStats.remainingToDispatch + booked * 0.1,
    },
    pastDue: isCurrent
      ? {
          pendingPlants: pastDueGroup.pastDuePendingOnSlot || 0,
          rolledInPlants: pastDueGroup.pastDueRolledInPlants || 0,
          pendingOrders: pastDueGroup.pastDuePendingOrders || 0,
        }
      : { pendingPlants: 0, rolledInPlants: 0, pendingOrders: 0 },
  };
}

function rollupTotals(rows) {
  return rows.reduce(
    (acc, r) => {
      acc.totalCapacity += r.capacity?.totalPlants || r.totalPlants || 0;
      acc.bookedPlants += r.booking?.bookedPlants || r.bookedPlants || 0;
      acc.availablePlants += r.capacity?.availablePlants || r.availablePlants || 0;
      acc.pendingDelivery += r.booking?.remainingToDispatch || 0;
      acc.dispatchedPlants += r.booking?.dispatchedPlants || 0;
      acc.needToProcure += r.fulfillment?.needToProcure || 0;
      acc.pastDuePending += r.pastDue?.pendingPlants || 0;
      acc.pastDueRolledIn += r.pastDue?.rolledInPlants || 0;
      if (r.capacity?.status === "overbooked") acc.overbookedSlots += 1;
      return acc;
    },
    {
      totalCapacity: 0,
      bookedPlants: 0,
      availablePlants: 0,
      pendingDelivery: 0,
      dispatchedPlants: 0,
      needToProcure: 0,
      pastDuePending: 0,
      pastDueRolledIn: 0,
      overbookedSlots: 0,
      slotCount: rows.length,
    }
  );
}

function buildPlantTree(rows, orders, slotMeta, { plantId, subtypeId }) {
  const plantMap = new Map();
  const ordersByPlantSubtype = new Map();

  for (const o of orders) {
    const pid = String(o.plantName);
    const sid = String(o.plantSubtype || "");
    const k = slotKey(pid, sid);
    const list = ordersByPlantSubtype.get(k) || [];
    list.push(o);
    ordersByPlantSubtype.set(k, list);
  }

  const filteredRows = rows.filter((r) => {
    if (plantId && String(r.plantId) !== String(plantId)) return false;
    if (subtypeId && String(r.subtypeId) !== String(subtypeId)) return false;
    return true;
  });

  const slotsBySubtype = new Map();
  for (const row of filteredRows) {
    const k = slotKey(row.plantId, row.subtypeId);
    const list = slotsBySubtype.get(k) || { meta: row, slots: [] };
    list.slots.push(row);
    slotsBySubtype.set(k, list);
  }

  for (const [k, { meta, slots }] of slotsBySubtype) {
    const subtypeOrders = ordersByPlantSubtype.get(k) || [];
    const slotDocs = slots.map((r) => ({ _id: r.slotId, startDay: r.startDay, endDay: r.endDay, month: r.month, status: true }));
    const ordersBySlot = groupOrdersByDeliverySlot(subtypeOrders, slotDocs);
    const pastDueGroup = aggregatePastDueMetricsForSlotGroup(slotDocs, ordersBySlot);

    const slotRows = slots.map((row) => {
      const sid = String(row.slotId);
      const pipeline = ordersBySlot.get(sid) || [];
      return buildSlotRow(row, slotMeta, pipeline, pipeline, pastDueGroup, sid);
    });

    const subtypeTotals = rollupTotals(slotRows);
    const pid = String(meta.plantId);
    let plant = plantMap.get(pid);
    if (!plant) {
      plant = {
        plantId: pid,
        plantName: meta.plantName,
        sowingAllowed: meta.sowingAllowed,
        subtypes: [],
        totals: null,
      };
      plantMap.set(pid, plant);
    }
    plant.subtypes.push({
      subtypeId: String(meta.subtypeId),
      subtypeName: meta.subtypeName,
      totals: subtypeTotals,
      utilizationPct:
        subtypeTotals.totalCapacity > 0
          ? Math.min(100, Math.round((subtypeTotals.bookedPlants / subtypeTotals.totalCapacity) * 100))
          : 0,
      slots: slotRows.sort((a, b) => (b.fulfillment?.loadScore || 0) - (a.fulfillment?.loadScore || 0)),
    });
  }

  const plants = [...plantMap.values()].map((p) => {
    const allSlots = p.subtypes.flatMap((s) => s.slots);
    p.totals = rollupTotals(allSlots);
    p.totals.utilizationPct =
      p.totals.totalCapacity > 0
        ? Math.min(100, Math.round((p.totals.bookedPlants / p.totals.totalCapacity) * 100))
        : 0;
    p.subtypes.sort((a, b) => b.totals.bookedPlants - a.totals.bookedPlants);
    return p;
  });

  plants.sort((a, b) => b.totals.bookedPlants - a.totals.bookedPlants);
  return plants;
}

export async function fetchSlotAnalysisCore({
  rangeStart,
  rangeEnd,
  startYmd,
  endYmd,
  year,
  plantId,
  subtypeId,
  includePastDue,
}) {
  const todayYmd = getIstTodayYmd();
  const { rows } = await fetchAvailabilityOverviewData({ year, plantId });
  const plantIds = plantId ? [plantId] : [...new Set(rows.map((r) => r.plantId))];

  const [slotMeta, allOrders] = await Promise.all([
    loadSlotFulfillmentMeta(year, plantId),
    loadAnalysisOrders(plantIds, year),
  ]);

  const rangeOrders = filterOrdersInRange(allOrders, rangeStart, rangeEnd);
  const deliveryChanges = filterDeliveryChangesInRange(allOrders, rangeStart, rangeEnd);

  let pastDueNative = 0;
  let pastDueRolled = 0;
  for (const o of allOrders) {
    if (!PENDING_STATUSES.has(o.orderStatus)) continue;
    const pending = getRemainingToDispatchQty(o);
    if (pending <= 0) continue;
    if (!isPastDueByDate(o, todayYmd)) continue;
    if (isPastDueRolledInOrder(o)) pastDueRolled += pending;
    else pastDueNative += pending;
  }

  const plants = buildPlantTree(rows, allOrders, slotMeta, { plantId, subtypeId });
  const allSlotRows = plants.flatMap((p) => p.subtypes.flatMap((s) => s.slots));
  const rolledUp = rollupTotals(allSlotRows.length ? allSlotRows : rows.map((r) => ({
    totalPlants: r.totalPlants,
    bookedPlants: r.bookedPlants,
    availablePlants: r.availablePlants,
    capacity: { status: r.status },
    booking: { remainingToDispatch: 0, dispatchedPlants: 0 },
    fulfillment: { needToProcure: Math.max(0, r.bookedPlants - (slotMeta.get(r.slotId)?.plantsSowed || 0)) },
    pastDue: { pendingPlants: 0, rolledInPlants: 0 },
  })));

  const pendingInRange = rangeOrders.reduce((s, o) => s + getRemainingToDispatchQty(o), 0);
  const dailyLoad = buildDailyLoad(allOrders, rangeStart, rangeEnd);
  const geoTop = buildGeoBreakdown(allOrders);

  const summary = {
    ...rolledUp,
    utilizationPct:
      rolledUp.totalCapacity > 0
        ? Math.min(100, Math.round((rolledUp.bookedPlants / rolledUp.totalCapacity) * 100))
        : 0,
    pendingDelivery: rolledUp.pendingDelivery || pendingInRange,
    pastDuePending: includePastDue ? pastDueNative + pastDueRolled : pastDueNative,
    pastDueExcludingRollover: pastDueNative,
    pastDueRolledIn: pastDueRolled,
    needToProcure: rolledUp.needToProcure,
    procureGapPct:
      rolledUp.bookedPlants > 0
        ? Math.round((rolledUp.needToProcure / rolledUp.bookedPlants) * 100)
        : 0,
    deliveryChangedOrders: deliveryChanges.orders,
    deliveryChangedPlants: deliveryChanges.plants,
    plantCount: plants.length,
    slotCount: rolledUp.slotCount || rows.length,
  };

  const slotLoad = allSlotRows
    .filter((s) => (s.booking?.remainingToDispatch || 0) + (s.booking?.bookedPlants || 0) > 0)
    .map((s) => ({
      slotId: s.slotId,
      label: s.label,
      month: s.month,
      bookedPlants: s.booking?.bookedPlants || 0,
      pendingPlants: s.booking?.remainingToDispatch || 0,
      loadPct: s.capacity?.utilizationPct || 0,
      status: s.capacity?.status,
    }))
    .sort((a, b) => b.pendingPlants - a.pendingPlants)
    .slice(0, 24);

  const plantPicker = [...new Map(rows.map((r) => [r.plantId, { plantId: r.plantId, plantName: r.plantName }])).values()]
    .sort((a, b) => a.plantName.localeCompare(b.plantName));

  return {
    summary,
    plants,
    plantPicker,
    dailyLoad,
    slotLoad,
    geoTop,
    deliveryChanges,
  };
}
