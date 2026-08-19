import mongoose from "mongoose";
import moment from "moment";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import SlotReadyRollLog from "../models/slotReadyRollLog.model.js";
import { resolveSlotBufferFields } from "../utility/bufferUtils.js";
import {
  aggregateSlotDispatchStats,
  getSlotDispatchStats,
} from "../utility/slotDispatchStats.js";
import { getSecondaryShedLinesForSlots } from "./secondaryShedSlotStock.service.js";

export const MONTH_ORDER = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const ROLL_LOG_LIMIT = 300;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const positive = (v) => Math.max(0, num(v));

const slotLabel = (slot) => `${slot?.startDay || ""} – ${slot?.endDay || ""}`;

const parseSlotDay = (value) => moment(value, "DD-MM-YYYY", true);

/** expired | current | upcoming from the slot's DD-MM-YYYY window. */
function resolveWindowState(slot, todayStart) {
  const start = parseSlotDay(slot?.startDay);
  const end = parseSlotDay(slot?.endDay);
  if (!start.isValid() || !end.isValid()) return "upcoming";
  if (end.isBefore(todayStart, "day")) return "expired";
  if (start.isAfter(todayStart, "day")) return "upcoming";
  return "current";
}

function sortByStartDay(slots) {
  return [...(slots || [])].sort((a, b) => {
    const ma = parseSlotDay(a.startDay);
    const mb = parseSlotDay(b.startDay);
    if (!ma.isValid() && !mb.isValid()) return 0;
    if (!ma.isValid()) return 1;
    if (!mb.isValid()) return -1;
    return ma.valueOf() - mb.valueOf();
  });
}

function toList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** Past-due rolled-in orders sitting on each slot (the "orders rolled" pill). */
async function aggregateRolledInOrders(slotObjectIds) {
  const map = new Map();
  if (!slotObjectIds.length) return map;

  const rows = await Order.aggregate([
    {
      $match: {
        bookingSlot: { $in: slotObjectIds },
        pastDueSlotRollover: true,
        orderStatus: { $nin: ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"] },
      },
    },
    {
      $group: {
        _id: "$bookingSlot",
        plants: {
          $sum: {
            $add: [
              { $ifNull: ["$numberOfPlants", 0] },
              { $ifNull: ["$additionalPlants", 0] },
            ],
          },
        },
        orderCount: { $sum: 1 },
      },
    },
  ]);

  for (const row of rows) {
    map.set(String(row._id), {
      plants: positive(row.plants),
      orderCount: positive(row.orderCount),
    });
  }
  return map;
}

function resolveSubtypeName(subtypeSlot, plantLean) {
  const fromSlot = subtypeSlot?.subtypeName || subtypeSlot?.name || "";
  if (fromSlot) return fromSlot;
  const sid = subtypeSlot?.subtypeId;
  if (!sid || !plantLean?.subtypes) return "";
  const sub = plantLean.subtypes.find((s) => String(s._id) === String(sid));
  return sub?.name || "";
}

/**
 * Month index over every slot of the year, including a compact descriptor per slot.
 * The pickers render from this, so narrowing the selection never hides a chip.
 */
function buildAvailableMonths(allSlots, todayStart) {
  const byMonth = new Map();
  for (const slot of allSlots) {
    const month = slot.month;
    if (!month) continue;
    if (!byMonth.has(month)) {
      byMonth.set(month, {
        month,
        slotCount: 0,
        slotIds: [],
        slots: [],
        actualPlants: 0,
        expectedMortality: 0,
        actualReadyPlants: 0,
        hasCurrentSlot: false,
      });
    }
    const entry = byMonth.get(month);
    const windowState = resolveWindowState(slot, todayStart);
    entry.slotCount += 1;
    entry.slotIds.push(String(slot._id));
    entry.slots.push({
      _id: String(slot._id),
      startDay: slot.startDay,
      endDay: slot.endDay,
      month,
      label: slotLabel(slot),
      windowState,
      actualPlants: positive(slot.actualPlants),
      expectedMortality: positive(slot.expectedMortality),
      actualReadyPlants: positive(slot.actualReadyPlants),
    });
    entry.actualPlants += positive(slot.actualPlants);
    entry.expectedMortality += positive(slot.expectedMortality);
    entry.actualReadyPlants += positive(slot.actualReadyPlants);
    if (windowState === "current") entry.hasCurrentSlot = true;
  }
  return MONTH_ORDER.filter((m) => byMonth.has(m)).map((m) => byMonth.get(m));
}

/**
 * Combined lagwad analysis across any set of months / slot windows for one subtype.
 *
 * Pools stay separate on purpose: actualPlants (sellable 90%), expectedMortality (10%
 * reserve) and actualReadyPlants (what a truck can actually load today).
 */
export async function getLagwadAnalysis({
  plantId,
  subtypeId,
  year,
  months,
  slotIds,
  metaOnly = false,
} = {}) {
  if (!mongoose.isValidObjectId(String(plantId))) {
    throw new Error("Valid plantId is required");
  }
  if (!mongoose.isValidObjectId(String(subtypeId))) {
    throw new Error("Valid subtypeId is required");
  }
  const yearNum = Number(year);
  if (!Number.isFinite(yearNum)) {
    throw new Error("Valid year is required");
  }

  const monthFilter = toList(months).filter((m) => MONTH_ORDER.includes(m));
  const slotFilter = toList(slotIds).filter((id) => mongoose.isValidObjectId(id));
  const todayStart = moment().startOf("day");

  const plantSlot = await PlantSlot.findOne({
    plantId: new mongoose.Types.ObjectId(String(plantId)),
    year: yearNum,
  })
    .populate("plantId", "name subtypes")
    .lean();

  const plantLean =
    plantSlot?.plantId && typeof plantSlot.plantId === "object" ? plantSlot.plantId : null;

  const emptyResult = {
    context: {
      plantId: String(plantId),
      plantName: plantLean?.name || "",
      subtypeId: String(subtypeId),
      subtypeName: "",
      year: yearNum,
      today: todayStart.format("YYYY-MM-DD"),
      todayLabel: todayStart.format("DD MMM YYYY"),
    },
    meta: {
      availableMonths: [],
      selectedMonths: monthFilter,
      selectedSlotIds: slotFilter,
      currentSlotId: null,
    },
    slots: [],
    lines: [],
    rolls: [],
    totals: emptyTotals(),
  };

  if (!plantSlot) return emptyResult;

  const subtypeSlot = (plantSlot.subtypeSlots || []).find(
    (st) => String(st.subtypeId) === String(subtypeId)
  );
  if (!subtypeSlot) return emptyResult;

  emptyResult.context.subtypeName = resolveSubtypeName(subtypeSlot, plantLean);

  const allSlots = sortByStartDay(subtypeSlot.slots || []);
  const availableMonths = buildAvailableMonths(allSlots, todayStart);
  const currentSlot = allSlots.find((s) => resolveWindowState(s, todayStart) === "current");

  let selected = allSlots;
  if (monthFilter.length) {
    selected = selected.filter((s) => monthFilter.includes(s.month));
  }
  if (slotFilter.length) {
    const wanted = new Set(slotFilter);
    selected = selected.filter((s) => wanted.has(String(s._id)));
  }

  const base = {
    ...emptyResult,
    meta: {
      availableMonths,
      selectedMonths: monthFilter,
      selectedSlotIds: slotFilter,
      currentSlotId: currentSlot ? String(currentSlot._id) : null,
    },
  };

  // The picker only needs meta — skip the order / lagwad / roll joins on that first call.
  if (metaOnly || !selected.length) return base;

  const slotObjectIds = selected
    .map((s) => s._id)
    .filter((id) => id && mongoose.isValidObjectId(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));

  const [orders, lines, rollLogs, rolledInOrders] = await Promise.all([
    Order.find({
      bookingSlot: { $in: slotObjectIds },
      orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
      $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }],
    })
      .select(
        "bookingSlot numberOfPlants additionalPlants remainingPlants dispatchHistory orderStatus"
      )
      .lean(),
    getSecondaryShedLinesForSlots(slotObjectIds),
    SlotReadyRollLog.find({
      $or: [
        { targetSlotId: { $in: slotObjectIds } },
        { sourceSlotId: { $in: slotObjectIds } },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(ROLL_LOG_LIMIT)
      .lean(),
    aggregateRolledInOrders(slotObjectIds),
  ]);

  const statsBySlot = aggregateSlotDispatchStats(orders);

  const linesBySlot = new Map();
  for (const line of lines) {
    if (!linesBySlot.has(line.slotId)) linesBySlot.set(line.slotId, []);
    linesBySlot.get(line.slotId).push(line);
  }

  const rolledInReadyBySlot = new Map();
  for (const log of rollLogs) {
    const target = String(log.targetSlotId);
    rolledInReadyBySlot.set(
      target,
      (rolledInReadyBySlot.get(target) || 0) + positive(log.quantityReady)
    );
  }

  const slotPayload = selected.map((slot) => {
    const slotId = String(slot._id);
    const stats = getSlotDispatchStats(statsBySlot, slot._id);
    const slotLines = linesBySlot.get(slotId) || [];
    const overdueLines = slotLines.filter((l) => l.overdueDays > 0);
    const overdueSum = overdueLines.reduce((s, l) => s + l.overdueDays, 0);
    const rolledOrders = rolledInOrders.get(slotId) || { plants: 0, orderCount: 0 };

    const actualPlants = positive(slot.actualPlants);
    const expectedMortality = positive(slot.expectedMortality);
    const actualReadyPlants = positive(slot.actualReadyPlants);
    const deliveryNeeded = positive(stats.remainingToDispatch);

    return {
      _id: slotId,
      startDay: slot.startDay,
      endDay: slot.endDay,
      month: slot.month,
      label: slotLabel(slot),
      windowState: resolveWindowState(slot, todayStart),
      isCurrentDateSlot: currentSlot ? String(currentSlot._id) === slotId : false,
      status: slot.status,
      isManual: Boolean(slot.isManual),

      totalPlants: positive(slot.totalPlants),
      availablePlants: resolveSlotBufferFields(slot).availablePlants,
      totalBookedPlants: positive(stats.totalBookedPlants),
      totalDispatchedPlants: positive(stats.totalDispatchedPlants),
      remainingToDispatch: deliveryNeeded,
      remainingNative: positive(stats.remainingNative),
      remainingRolledIn: positive(stats.remainingRolledIn),

      actualPlants,
      expectedMortality,
      actualReadyPlants,
      lagwadRemaining: positive(slot.lagwadRemaining),
      lagwadGross: actualPlants + expectedMortality,
      rolledInActualReadyPlants: positive(
        slot.rolledInActualReadyPlants || rolledInReadyBySlot.get(slotId)
      ),
      rolledInAvailablePlants: positive(slot.rolledInAvailablePlants),
      rolledInOrderPlants: rolledOrders.plants,
      rolledInOrderCount: rolledOrders.orderCount,

      lineCount: slotLines.length,
      batchCount: new Set(slotLines.map((l) => l.batchId)).size,
      overdueLineCount: overdueLines.length,
      avgOverdueDays: overdueLines.length
        ? Math.round(overdueSum / overdueLines.length)
        : 0,
      maxOverdueDays: overdueLines.reduce((m, l) => Math.max(m, l.overdueDays), 0),

      readyGap: Math.max(0, deliveryNeeded - actualReadyPlants),
      physicalGap: Math.max(0, deliveryNeeded - actualPlants),
      isOverbooked: resolveSlotBufferFields(slot).availablePlants < 0,
    };
  });

  const slotLabelById = new Map(slotPayload.map((s) => [s._id, s.label]));
  const enrichedLines = lines.map((line) => ({
    ...line,
    slotLabel: slotLabelById.get(line.slotId) || "",
  }));

  const rolls = rollLogs.map((log) => ({
    _id: String(log._id),
    createdAt: log.createdAt,
    createdAtLabel: moment(log.createdAt).format("DD MMM YYYY"),
    batchNumber: log.batchNumber || "",
    pollyhouse: log.pollyhouse || "",
    quantityReady: positive(log.quantityReady),
    overdueDays: positive(log.overdueDays),
    expectedReadyDate: log.expectedReadyDate || null,
    rollKind: log.rollKind,
    isAuto: log.rollKind === "expired_auto",
    sourceSlotId: String(log.sourceSlotId),
    targetSlotId: String(log.targetSlotId),
    sourceSlotLabel: log.sourceSlotLabel || slotLabelById.get(String(log.sourceSlotId)) || "",
    targetSlotLabel: log.targetSlotLabel || slotLabelById.get(String(log.targetSlotId)) || "",
    reason: log.reason || "",
    direction: slotLabelById.has(String(log.targetSlotId)) ? "in" : "out",
  }));

  return {
    ...base,
    slots: slotPayload,
    lines: enrichedLines,
    rolls,
    totals: rollupTotals(slotPayload, enrichedLines, rolls),
  };
}

function emptyTotals() {
  return {
    slotCount: 0,
    lineCount: 0,
    batchCount: 0,
    sellablePool: 0,
    expectedMortality: 0,
    readyToDispatch: 0,
    lagwadGross: 0,
    deliveryNeeded: 0,
    booked: 0,
    capacity: 0,
    dispatched: 0,
    available: 0,
    readyGap: 0,
    physicalGap: 0,
    readySurplus: 0,
    physicalSurplus: 0,
    gapPct: 0,
    readyCoveredByReady: 0,
    overdueLineCount: 0,
    avgOverdueDays: 0,
    maxOverdueDays: 0,
    readyRolledIn: 0,
    ordersRolledIn: 0,
    pendingSlotSync: 0,
    // Active windows only (expired slots excluded) — what can still be sold and loaded.
    activeSlotCount: 0,
    activeAvailablePlants: 0,
    activeReadyPlants: 0,
    activeExpectedMortality: 0,
    activeSellablePool: 0,
    activeLagwadGross: 0,
    expiredReadyPlants: 0,
  };
}

/**
 * Month/selection rollup. Gap arithmetic mirrors rollupMonthSlotMetrics on the client
 * so both sides report the same shortfall.
 */
export function rollupTotals(slots, lines, rolls) {
  const totals = emptyTotals();
  totals.slotCount = slots.length;

  for (const slot of slots) {
    totals.sellablePool += slot.actualPlants;
    totals.expectedMortality += slot.expectedMortality;
    totals.readyToDispatch += slot.actualReadyPlants;
    totals.lagwadGross += slot.lagwadGross;
    totals.deliveryNeeded += slot.remainingToDispatch;
    totals.booked += slot.totalBookedPlants;
    totals.capacity += slot.totalPlants;
    totals.dispatched += slot.totalDispatchedPlants;
    totals.available += slot.availablePlants;
    totals.readyRolledIn += slot.rolledInActualReadyPlants;
    totals.ordersRolledIn += slot.rolledInOrderPlants;

    if (slot.windowState === "expired") {
      totals.expiredReadyPlants += slot.actualReadyPlants;
    } else {
      totals.activeSlotCount += 1;
      totals.activeAvailablePlants += slot.availablePlants;
      totals.activeReadyPlants += slot.actualReadyPlants;
      totals.activeExpectedMortality += slot.expectedMortality;
      totals.activeSellablePool += slot.actualPlants;
      totals.activeLagwadGross += slot.lagwadGross;
    }
  }

  const overdueLines = lines.filter((l) => l.overdueDays > 0);
  totals.lineCount = lines.length;
  totals.batchCount = new Set(lines.map((l) => l.batchId)).size;
  totals.overdueLineCount = overdueLines.length;
  totals.avgOverdueDays = overdueLines.length
    ? Math.round(overdueLines.reduce((s, l) => s + l.overdueDays, 0) / overdueLines.length)
    : 0;
  totals.maxOverdueDays = overdueLines.reduce((m, l) => Math.max(m, l.overdueDays), 0);
  totals.pendingSlotSync = lines.reduce((s, l) => s + positive(l.pendingSlotSync), 0);

  const readyRaw = totals.deliveryNeeded - totals.readyToDispatch;
  totals.readyGap = Math.max(0, readyRaw);
  totals.readySurplus = Math.max(0, -readyRaw);

  const physicalRaw = totals.deliveryNeeded - totals.sellablePool;
  totals.physicalGap = Math.max(0, physicalRaw);
  totals.physicalSurplus = Math.max(0, -physicalRaw);

  totals.readyCoveredByReady = Math.min(totals.deliveryNeeded, totals.readyToDispatch);
  totals.gapPct =
    totals.deliveryNeeded > 0
      ? Math.round((totals.readyGap / totals.deliveryNeeded) * 100)
      : 0;

  totals.rollCount = (rolls || []).length;

  return totals;
}
