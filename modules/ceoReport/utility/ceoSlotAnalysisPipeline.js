import moment from "moment";
import Order from "../../../models/order.model.js";
import PlantSlot from "../../../models/slots.model.js";
import { fetchAvailabilityOverviewData } from "../../../services/whatsappReportAvailability.service.js";
import {
  groupOrdersByDeliverySlot,
  resolveBookingSlotId,
  isSlotStatEligibleOrder,
} from "../../../utility/slotDispatchStats.js";
import { aggregatePastDueMetricsForSlotGroup, isPastDueRolledInOrder } from "../../../utility/pastDueSlotMetrics.js";
import { getIstTodayYmd, LINE_PLANT_TOTAL_ADD_FIELDS } from "../../../utility/istOrderDateStats.js";
import { filterRowsInRange, getSlotPhase, isSlotActiveToday } from "./ceoSlotDateFilter.js";
import {
  linePlants,
  pendingPlants,
  dispatchedPlants,
  slotIdsOrderMatch,
  deliveryRangeMatch,
  pastDueMatch,
  rollupOrderMetrics,
} from "./ceoSlotOrderMetrics.js";

const IST = "Asia/Kolkata";

function slotKey(plantId, subtypeId) {
  return `${plantId}::${subtypeId}`;
}

async function loadSlotMeta(year, plantId) {
  const filter = { year: Number(year) };
  if (plantId) filter.plantId = plantId;
  const docs = await PlantSlot.find(filter).select("plantId subtypeSlots").lean();
  const bySlotId = new Map();
  for (const doc of docs) {
    for (const st of doc.subtypeSlots || []) {
      for (const slot of st.slots || []) {
        if (slot.status === false) continue;
        bySlotId.set(String(slot._id), {
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

function groupOrdersByBookingSlot(orders, slots) {
  const map = new Map();
  for (const slot of slots || []) {
    const id = slot._id?.toString?.() ?? String(slot._id);
    map.set(id, []);
  }
  for (const order of orders || []) {
    if (!isSlotStatEligibleOrder(order)) continue;
    const slotId = resolveBookingSlotId(order.bookingSlot);
    if (slotId && map.has(slotId)) map.get(slotId).push(order);
  }
  return map;
}

function mergeSlotOrders(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const o of list || []) {
      const id = String(o._id);
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(o);
    }
  }
  return merged;
}

/** Slot-scoped orders (bookingSlot) + delivery cohort for charts + past-due. */
async function loadOrdersBundle(slotIds, plantIds, rangeStart, rangeEnd, withGeo) {
  const geoStages = withGeo
    ? [
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
            village: { $ifNull: [{ $arrayElemAt: ["$_farmer.village", 0] }, ""] },
            taluka: { $ifNull: [{ $arrayElemAt: ["$_farmer.talukaName", 0] }, ""] },
            district: { $ifNull: [{ $arrayElemAt: ["$_farmer.districtName", 0] }, ""] },
          },
        },
      ]
    : [];

  const projectFields = {
    orderStatus: 1,
    numberOfPlants: 1,
    additionalPlants: 1,
    bookingSlot: 1,
    deliveryDate: 1,
    deliveryChanges: 1,
    plantName: 1,
    plantSubtype: 1,
    quotaSource: 1,
    dealerOrder: 1,
    pastDueRolledFromSlotId: 1,
    pastDueRolledAt: 1,
  };

  const [slotOrders, deliveryOrders, pastDueOrders] = await Promise.all([
    slotIds.length
      ? Order.aggregate([
          { $match: slotIdsOrderMatch(slotIds, plantIds) },
          { $project: projectFields },
          { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
          ...geoStages,
        ])
      : [],
    Order.aggregate([
      { $match: deliveryRangeMatch(plantIds, rangeStart, rangeEnd) },
      { $project: projectFields },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    ]),
    Order.aggregate([
      { $match: pastDueMatch(plantIds, rangeStart) },
      { $project: projectFields },
      { $addFields: { ...LINE_PLANT_TOTAL_ADD_FIELDS, _pastDue: true } },
      ...geoStages,
    ]),
  ]);

  const allOrders = mergeSlotOrders(slotOrders, pastDueOrders);
  const chartOrders = deliveryOrders.filter((o) => isSlotStatEligibleOrder(o));
  return { slotOrders, chartOrders, pastDueOrders, allOrders };
}

function buildDailyLoad(chartOrders, rangeStart, rangeEnd) {
  const todayYmd = getIstTodayYmd();
  const byDay = new Map();
  const cur = moment(rangeStart).utcOffset(330).startOf("day");
  const end = moment(rangeEnd).utcOffset(330).startOf("day");
  while (cur.isSameOrBefore(end, "day")) {
    const key = cur.format("YYYY-MM-DD");
    byDay.set(key, {
      key,
      label: cur.format("D MMM"),
      bookedPlants: 0,
      pendingPlants: 0,
      dispatchedPlants: 0,
      orders: 0,
      pastDue: key < todayYmd,
    });
    cur.add(1, "day");
  }

  for (const o of chartOrders) {
    if (!isSlotStatEligibleOrder(o) || !o.deliveryDate) continue;
    const key = new Date(o.deliveryDate).toLocaleDateString("en-CA", { timeZone: IST });
    if (!byDay.has(key)) continue;
    const row = byDay.get(key);
    row.bookedPlants += linePlants(o);
    row.pendingPlants += pendingPlants(o);
    row.dispatchedPlants += dispatchedPlants(o);
    if (pendingPlants(o) > 0) row.orders += 1;
  }
  return [...byDay.values()];
}

function buildWeeklyLoad(dailyLoad) {
  const weeks = new Map();
  for (const d of dailyLoad) {
    const wk = moment(d.key, "YYYY-MM-DD").utcOffset(330).startOf("isoWeek").format("YYYY-MM-DD");
    const row = weeks.get(wk) || {
      key: wk,
      label: moment(wk, "YYYY-MM-DD").format("D MMM") + " wk",
      bookedPlants: 0,
      pendingPlants: 0,
      dispatchedPlants: 0,
    };
    row.bookedPlants += d.bookedPlants;
    row.pendingPlants += d.pendingPlants;
    row.dispatchedPlants += d.dispatchedPlants;
    weeks.set(wk, row);
  }
  return [...weeks.values()];
}

function buildGeoBreakdown(orders) {
  const talukaMap = new Map();
  const districtMap = new Map();
  for (const o of orders) {
    const p = pendingPlants(o);
    if (p <= 0) continue;
    const taluka = o.taluka || "Unknown";
    const district = o.district || "Unknown";
    const t = talukaMap.get(taluka) || { taluka, plants: 0, orders: 0 };
    t.plants += p;
    t.orders += 1;
    talukaMap.set(taluka, t);
    const d = districtMap.get(district) || { district, plants: 0, orders: 0 };
    d.plants += p;
    d.orders += 1;
    districtMap.set(district, d);
  }
  return {
    byTaluka: [...talukaMap.values()].sort((a, b) => b.plants - a.plants).slice(0, 12),
    byDistrict: [...districtMap.values()].sort((a, b) => b.plants - a.plants).slice(0, 10),
  };
}

function bookedFromSlotOrders(orders) {
  let total = 0;
  for (const o of orders || []) {
    if (!isSlotStatEligibleOrder(o) || isPastDueRolledInOrder(o)) continue;
    total += linePlants(o);
  }
  return total;
}

function pastDuePlantsOnSlot(slotId, slotOrders, pastDueGroup) {
  const bucket = pastDueGroup?.pastDueDetail?.pendingBySlot?.find((b) => b.slotId === slotId);
  let rolled = 0;
  for (const o of slotOrders || []) {
    if (isPastDueRolledInOrder(o)) rolled += pendingPlants(o);
  }
  return (bucket?.plants || 0) + rolled;
}

function buildSlotRow(row, slotMeta, slotOrders, pastDueGroup, slotId) {
  const meta = slotMeta.get(slotId) || {};
  const booked = bookedFromSlotOrders(slotOrders);
  const pending = slotOrders.reduce((s, o) => s + pendingPlants(o), 0);
  const dispatched = slotOrders.reduce((s, o) => s + dispatchedPlants(o), 0);
  const dispatchedNative = slotOrders.reduce((s, o) => {
    if (isPastDueRolledInOrder(o)) return s;
    return s + dispatchedPlants(o);
  }, 0);
  const dispatchedOther = slotOrders.reduce((s, o) => {
    if (!isPastDueRolledInOrder(o)) return s;
    return s + dispatchedPlants(o);
  }, 0);
  const remainingNative = slotOrders.reduce((s, o) => {
    if (isPastDueRolledInOrder(o)) return s;
    return s + pendingPlants(o);
  }, 0);
  const remainingRolledIn = slotOrders.reduce((s, o) => {
    if (!isPastDueRolledInOrder(o)) return s;
    return s + pendingPlants(o);
  }, 0);
  const sowed = Math.max(meta.plantsSowed || 0, meta.primarySowed || 0);
  const actual = meta.actualPlants || 0;
  const stockBase = Math.max(sowed, actual);
  const needToProcure = Math.max(0, booked - stockBase);
  // Physical position: full pre-dispatch queue (native + rolled) vs actual stock on slot.
  const actualRemaining = remainingNative + remainingRolledIn;
  const actualAvailable = Math.max(0, actual - actualRemaining);
  const actualGap = Math.max(0, actualRemaining - actual);
  const isCurrent = slotId === pastDueGroup?.currentSlotId;
  const phase = getSlotPhase(row);
  const isActiveSlot = isCurrent || isSlotActiveToday(row);
  const pastDuePlants = pastDuePlantsOnSlot(slotId, slotOrders, pastDueGroup);
  const needToDeliver = pending;

  return {
    slotId,
    month: row.month,
    startDay: row.startDay,
    endDay: row.endDay,
    label: `${row.startDay} – ${row.endDay}`,
    isActiveSlot,
    isCurrentSlot: isCurrent,
    slotPhase: phase,
    capacity: {
      totalPlants: row.totalPlants,
      availablePlants: row.availablePlants,
      utilizationPct: row.utilizationPct,
      status: row.status,
    },
    booking: {
      bookedPlants: booked,
      dispatchedPlants: dispatched,
      dispatchedNative,
      dispatchedOther,
      remainingToDispatch: pending,
      needToDeliver,
      remainingNative,
      remainingRolledIn,
    },
    fulfillment: {
      plantsSowed: sowed,
      actualPlants: actual,
      actualRemaining,
      actualAvailable,
      actualGap,
      closingStock: meta.closingStock || 0,
      needToProcure,
      loadScore: pending + booked * 0.05,
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

function rollupSlotRows(rows) {
  return rows.reduce(
    (acc, r) => {
      acc.totalCapacity += Math.round(r.capacity?.totalPlants || 0);
      acc.bookedPlants += r.booking?.bookedPlants || 0;
      acc.availablePlants += Math.round(r.capacity?.availablePlants || 0);
      acc.pendingDelivery += r.booking?.remainingToDispatch || 0;
      acc.needToDeliver += r.booking?.needToDeliver || r.booking?.remainingToDispatch || 0;
      acc.dispatchedPlants += r.booking?.dispatchedPlants || 0;
      acc.dispatchedNative += r.booking?.dispatchedNative || 0;
      acc.dispatchedOther += r.booking?.dispatchedOther || 0;
      if (r.isActiveSlot) acc.activeSlotCount += 1;
      acc.needToProcure += r.fulfillment?.needToProcure || 0;
      acc.actualPlants += r.fulfillment?.actualPlants || 0;
      acc.actualRemaining += r.fulfillment?.actualRemaining || 0;
      acc.actualAvailable += r.fulfillment?.actualAvailable || 0;
      acc.actualGap += r.fulfillment?.actualGap || 0;
      acc.pastDuePending += (r.pastDue?.pendingPlants || 0) + (r.pastDue?.rolledInPlants || 0);
      acc.pastDueRolledIn += r.pastDue?.rolledInPlants || 0;
      if (r.capacity?.status === "overbooked") acc.overbookedSlots += 1;
      return acc;
    },
    {
      totalCapacity: 0,
      bookedPlants: 0,
      availablePlants: 0,
      pendingDelivery: 0,
      needToDeliver: 0,
      dispatchedPlants: 0,
      dispatchedNative: 0,
      dispatchedOther: 0,
      needToProcure: 0,
      actualPlants: 0,
      actualRemaining: 0,
      actualAvailable: 0,
      actualGap: 0,
      activeSlotCount: 0,
      pastDuePending: 0,
      pastDueRolledIn: 0,
      overbookedSlots: 0,
      slotCount: rows.length,
    }
  );
}

function buildPlantTree(rangeRows, slotOrders, slotMeta, { plantId, subtypeId }) {
  const filtered = rangeRows.filter((r) => {
    if (plantId && String(r.plantId) !== String(plantId)) return false;
    if (subtypeId && String(r.subtypeId) !== String(subtypeId)) return false;
    return true;
  });

  const bySubtype = new Map();
  for (const row of filtered) {
    const k = slotKey(row.plantId, row.subtypeId);
    const g = bySubtype.get(k) || { meta: row, slots: [] };
    g.slots.push(row);
    bySubtype.set(k, g);
  }

  const plantMap = new Map();
  for (const [, { meta, slots }] of bySubtype) {
    const slotDocs = slots.map((r) => ({
      _id: r.slotId,
      startDay: r.startDay,
      endDay: r.endDay,
      month: r.month,
      status: true,
    }));
    const ordersByBooking = groupOrdersByBookingSlot(slotOrders, slotDocs);
    const ordersByDelivery = groupOrdersByDeliverySlot(slotOrders, slotDocs);
    const pastDueGroup = aggregatePastDueMetricsForSlotGroup(slotDocs, ordersByDelivery);

    const slotRows = slots.map((row) => {
      const sid = String(row.slotId);
      const merged = mergeSlotOrders(ordersByBooking.get(sid), ordersByDelivery.get(sid));
      return buildSlotRow(row, slotMeta, merged, pastDueGroup, sid);
    });

    const subtypeTotals = rollupSlotRows(slotRows);
    const pid = String(meta.plantId);
    let plant = plantMap.get(pid);
    if (!plant) {
      plant = { plantId: pid, plantName: meta.plantName, sowingAllowed: meta.sowingAllowed, subtypes: [], totals: null };
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
      slots: slotRows.sort((a, b) => {
        if (a.isActiveSlot !== b.isActiveSlot) return a.isActiveSlot ? -1 : 1;
        return (b.fulfillment?.loadScore || 0) - (a.fulfillment?.loadScore || 0);
      }),
    });
  }

  return [...plantMap.values()]
    .map((p) => {
      const allSlots = p.subtypes.flatMap((s) => s.slots);
      p.totals = rollupSlotRows(allSlots);
      p.totals.utilizationPct =
        p.totals.totalCapacity > 0
          ? Math.min(100, Math.round((p.totals.bookedPlants / p.totals.totalCapacity) * 100))
          : 0;
      p.subtypes.sort((a, b) => b.totals.bookedPlants - a.totals.bookedPlants);
      return p;
    })
    .sort((a, b) => b.totals.bookedPlants - a.totals.bookedPlants);
}

export async function fetchSlotAnalysisCore({
  rangeStart,
  rangeEnd,
  year,
  plantId,
  subtypeId,
  includePastDue,
  withGeo = true,
}) {
  const { rows: allRows } = await fetchAvailabilityOverviewData({ year, plantId });
  const rangeRows = filterRowsInRange(allRows, rangeStart, rangeEnd);
  const effectivePlantIds = plantId ? [plantId] : [...new Set(rangeRows.map((r) => r.plantId))];

  if (!effectivePlantIds.length) {
    return {
      summary: {
        totalCapacity: 0,
        bookedPlants: 0,
        availablePlants: 0,
        utilizationPct: 0,
        pendingDelivery: 0,
        needToDeliver: 0,
        needToDeliverInRange: 0,
        dispatchedPlants: 0,
        dispatchedNative: 0,
        dispatchedOther: 0,
        actualPlants: 0,
        actualRemaining: 0,
        actualAvailable: 0,
        actualGap: 0,
        pastDuePending: 0,
        pastDueExcludingRollover: 0,
        pastDueRolledIn: 0,
        needToProcure: 0,
        procureGapPct: 0,
        deliveryChangedOrders: 0,
        deliveryChangedPlants: 0,
        overbookedSlots: 0,
        activeSlotCount: 0,
        plantCount: 0,
        slotCount: 0,
        statusBreakdown: [],
      },
      plants: [],
      plantPicker: [],
      activeSlots: [],
      dailyLoad: [],
      weeklyLoad: [],
      slotLoad: [],
      geoTop: { byTaluka: [], byDistrict: [] },
      statusBreakdown: [],
    };
  }

  const slotIds = rangeRows.map((r) => r.slotId).filter(Boolean);

  const [slotMeta, orderBundle] = await Promise.all([
    loadSlotMeta(year, plantId),
    loadOrdersBundle(slotIds, effectivePlantIds, rangeStart, rangeEnd, withGeo),
  ]);

  const { slotOrders, chartOrders, pastDueOrders, allOrders } = orderBundle;

  const plants = buildPlantTree(rangeRows, slotOrders, slotMeta, { plantId, subtypeId });
  const slotRollup = rollupSlotRows(plants.flatMap((p) => p.subtypes.flatMap((s) => s.slots)));

  const orderMetrics = rollupOrderMetrics(allOrders, rangeStart, rangeEnd, {
    bookedFromSlots: slotRollup.bookedPlants,
  });
  const pipelineOrders = mergeSlotOrders(slotOrders, pastDueOrders);
  const needToDeliverTotal = pipelineOrders.reduce((s, o) => s + pendingPlants(o), 0);

  let pastDueNative = 0;
  let pastDueRolled = 0;
  for (const o of pastDueOrders) {
    const p = pendingPlants(o);
    if (p <= 0) continue;
    if (isPastDueRolledInOrder(o)) pastDueRolled += p;
    else pastDueNative += p;
  }

  const activeSlots = plants
    .flatMap((p) => p.subtypes.flatMap((s) => s.slots))
    .filter((s) => s.isActiveSlot)
    .map((s) => ({
      slotId: s.slotId,
      label: s.label,
      plantId: plants.find((p) => p.subtypes.some((st) => st.slots.some((sl) => sl.slotId === s.slotId)))?.plantId,
      needToDeliver: s.booking?.needToDeliver || s.booking?.remainingToDispatch || 0,
      pending: s.booking?.remainingToDispatch || 0,
      pastDue: (s.pastDue?.pendingPlants || 0) + (s.pastDue?.rolledInPlants || 0),
    }));

  const dailyLoad = buildDailyLoad(chartOrders, rangeStart, rangeEnd);
  const weeklyLoad = buildWeeklyLoad(dailyLoad);
  const geoTop = withGeo ? buildGeoBreakdown([...allOrders, ...pastDueOrders]) : { byTaluka: [], byDistrict: [] };

  const summary = {
    totalCapacity: slotRollup.totalCapacity || Math.round(rangeRows.reduce((s, r) => s + r.totalPlants, 0)),
    bookedPlants: slotRollup.bookedPlants,
    availablePlants: Math.max(
      0,
      (slotRollup.totalCapacity || 0) - slotRollup.bookedPlants
    ),
    utilizationPct:
      slotRollup.totalCapacity > 0
        ? Math.min(100, Math.round((slotRollup.bookedPlants / slotRollup.totalCapacity) * 100))
        : 0,
    pendingDelivery: slotRollup.pendingDelivery,
    needToDeliver: needToDeliverTotal,
    needToDeliverInRange: slotRollup.needToDeliver,
    dispatchedPlants: slotRollup.dispatchedPlants,
    dispatchedNative: slotRollup.dispatchedNative,
    dispatchedOther: slotRollup.dispatchedOther,
    actualPlants: slotRollup.actualPlants,
    actualRemaining: slotRollup.actualRemaining,
    actualAvailable: slotRollup.actualAvailable,
    actualGap: slotRollup.actualGap,
    activeSlotCount: slotRollup.activeSlotCount,
    pastDuePending: includePastDue ? pastDueNative + pastDueRolled : pastDueNative,
    pastDueExcludingRollover: pastDueNative,
    pastDueRolledIn: pastDueRolled,
    needToProcure: slotRollup.needToProcure,
    procureGapPct:
      slotRollup.bookedPlants > 0
        ? Math.round((slotRollup.needToProcure / slotRollup.bookedPlants) * 100)
        : 0,
    deliveryChangedOrders: orderMetrics.deliveryChangedOrders,
    deliveryChangedPlants: orderMetrics.deliveryChangedPlants,
    overbookedSlots: slotRollup.overbookedSlots,
    plantCount: plants.length,
    slotCount: rangeRows.length,
    statusBreakdown: orderMetrics.statusBreakdown,
  };

  const slotLoad = plants
    .flatMap((p) => p.subtypes.flatMap((s) => s.slots))
    .filter((s) => (s.booking?.remainingToDispatch || 0) + (s.booking?.bookedPlants || 0) > 0)
    .map((s) => ({
      slotId: s.slotId,
      label: s.label,
      month: s.month,
      bookedPlants: s.booking?.bookedPlants || 0,
      pendingPlants: s.booking?.remainingToDispatch || 0,
      dispatchedPlants: s.booking?.dispatchedPlants || 0,
      loadPct: s.capacity?.utilizationPct || 0,
      status: s.capacity?.status,
    }))
    .sort((a, b) => b.pendingPlants - a.pendingPlants)
    .slice(0, 30);

  const plantPicker = [...new Map(allRows.map((r) => [r.plantId, { plantId: r.plantId, plantName: r.plantName }])).values()]
    .sort((a, b) => a.plantName.localeCompare(b.plantName));

  return {
    summary,
    plants,
    plantPicker,
    activeSlots,
    dailyLoad,
    weeklyLoad,
    slotLoad,
    geoTop,
    statusBreakdown: orderMetrics.statusBreakdown,
  };
}
