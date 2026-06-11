import Order from "../models/order.model.js";
import OrderEvent from "../modules/orderEvents/models/orderEvent.model.js";
import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
  istDateStringExpr,
} from "./istOrderDateStats.js";
import {
  matchDeliveryDateInRange,
  matchDeliveryDateBeforeRange,
} from "./centralReportEngine/deliveryMatch.js";

export {
  DELIVERY_TOTAL_EXCLUDED_STATUSES,
  matchDeliveryDateInRange,
  matchDeliveryDateBeforeRange,
} from "./centralReportEngine/deliveryMatch.js";
import {
  emptyOrderPlants,
  emptyDeliveryDay,
  bookingRowsToMap,
  uniqueRowsToMap,
  addOrderPlants,
  addDeliveryDays,
} from "./adminDailyMisMerge.js";
import { duePipelineMatch } from "./adminMisDue.js";
import {
  transitionHistoryByDayStages,
  transitionLegacyByDayStages,
  transitionHistoryByDayPerOrderStages,
  transitionLegacyByDayPerOrderStages,
  transitionHistoryByEntityPerOrderStages,
  transitionLegacyByEntityPerOrderStages,
  transitionHistoryByEntityStages,
  transitionLegacyByEntityStages,
} from "./misTransitionMetrics.js";
import {
  aggregateTransitionEventsByDay,
  aggregateTransitionEventsByGroup,
  distinctOrderIdsWithTransitionEvents,
  transitionExcludeOrderIdsMatch,
  transitionEventsByDayPerOrderStages,
  transitionEventsByEntityPerOrderStages,
} from "./misTransitionFromEvents.js";

const IST = "Asia/Kolkata";
const REMAINING_STATUSES = [
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
];

const PIPELINE_DELIVERY_STATUSES = [
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
  "PENDING",
  "PROCESSING",
  "ASSIGNED",
];

function metricFromAgg(rows) {
  return {
    orders: rows[0]?.orders ?? 0,
    plants: rows[0]?.plants ?? 0,
  };
}

function rowsToDayMap(rows, { withRemaining = false } = {}) {
  const map = new Map();
  for (const row of rows || []) {
    const day = row._id?.day ?? row._id;
    if (!day) continue;
    if (!map.has(day)) {
      map.set(day, { orders: 0, plants: 0, plantsRemaining: 0 });
    }
    const b = map.get(day);
    b.orders += row.orders || 0;
    b.plants += row.plants || 0;
    if (withRemaining) b.plantsRemaining += row.plantsRemaining || 0;
  }
  return map;
}

/** All orders with a given current status (no delivery-date filter). */
export async function aggregateGlobalStatus(status, statusMatch, extraMatch = {}) {
  const rows = await Order.aggregate([
    { $match: { ...statusMatch, ...extraMatch, orderStatus: status } },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    {
      $group: {
        _id: null,
        orders: { $sum: 1 },
        plants: { $sum: "$linePlantTotal" },
      },
    },
  ]);
  return metricFromAgg(rows);
}

/** Delivery in range + ACCEPTED, grouped by delivery IST day. */
export async function aggregateAcceptedByDeliveryDay(
  rangeStart,
  rangeEnd,
  statusMatch,
  extraMatch = {}
) {
  const rows = await Order.aggregate([
    {
      $match: {
        ...statusMatch,
        ...extraMatch,
        orderStatus: "ACCEPTED",
        deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null },
      },
    },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    {
      $group: {
        _id: {
          day: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$deliveryDate",
              timezone: IST,
            },
          },
        },
        orders: { $sum: 1 },
        plants: { $sum: "$linePlantTotal" },
      },
    },
  ]);
  return rowsToDayMap(rows);
}

/**
 * Out / Done: OrderEvent first, then statusChanges, then legacy updatedAt.
 */
function mergeTransitionDayRows(...rowSets) {
  const map = new Map();
  for (const rows of rowSets) {
    for (const row of rows || []) {
      const day = row._id?.day ?? row._id;
      if (!day) continue;
      if (!map.has(day)) map.set(day, { orders: 0, plants: 0 });
      const bucket = map.get(day);
      bucket.orders += row.orders || 0;
      bucket.plants += row.plants || 0;
    }
  }
  return map;
}

function orderDayKey(day, orderId) {
  return `${day}\0${String(orderId)}`;
}

/** Merge per-order-day rows (one plant total per day + order). */
function mergeTransitionOrderDayRows(...rowSets) {
  const map = new Map();
  for (const rows of rowSets) {
    for (const row of rows || []) {
      const day = row._id?.day;
      const orderId = row._id?.orderId;
      if (!day || orderId == null) continue;
      const key = orderDayKey(day, orderId);
      if (!map.has(key)) {
        map.set(key, { day, orderId: String(orderId), plants: row.plants || 0 });
      }
    }
  }
  return map;
}

function rollupOrderDayMapToDayTotals(orderDayMap) {
  const map = new Map();
  for (const entry of orderDayMap.values()) {
    if (!map.has(entry.day)) map.set(entry.day, { orders: 0, plants: 0 });
    const bucket = map.get(entry.day);
    bucket.orders += 1;
    bucket.plants += entry.plants || 0;
  }
  return map;
}

function entityOrderKey(idObj) {
  return JSON.stringify(idObj);
}

function entityKeyFromId(idObj) {
  const { orderId, ...entity } = idObj || {};
  return JSON.stringify(entity);
}

/** Merge per-entity-order rows (one plant total per entity + order in range). */
function mergeTransitionEntityOrderRows(...rowSets) {
  const map = new Map();
  for (const rows of rowSets) {
    for (const row of rows || []) {
      if (!row._id || row._id.orderId == null) continue;
      const key = entityOrderKey(row._id);
      if (!map.has(key)) {
        map.set(key, { _id: row._id, plants: row.plants || 0 });
      }
    }
  }
  return map;
}

function rollupEntityOrderMapToRows(entityOrderMap) {
  const byEntity = new Map();
  for (const row of entityOrderMap.values()) {
    const eKey = entityKeyFromId(row._id);
    if (!byEntity.has(eKey)) {
      const { orderId, ...entityId } = row._id;
      byEntity.set(eKey, { _id: entityId, orders: 0, plants: 0 });
    }
    const slot = byEntity.get(eKey);
    slot.orders += 1;
    slot.plants += row.plants || 0;
  }
  return [...byEntity.values()];
}

async function aggregateTransitionsByDayPerOrder(
  newStatus,
  rangeStart,
  rangeEnd,
  statusMatch,
  extraMatch = {}
) {
  const match = { ...statusMatch, ...extraMatch };
  const eventOrderIds = await distinctOrderIdsWithTransitionEvents(
    newStatus,
    rangeStart,
    rangeEnd
  );
  const exclude = transitionExcludeOrderIdsMatch(eventOrderIds);
  const [eventRows, historyRows, legacyRows] = await Promise.all([
    OrderEvent.aggregate(
      transitionEventsByDayPerOrderStages(newStatus, rangeStart, rangeEnd, match)
    ),
    Order.aggregate([
      { $match: { ...match, ...exclude } },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      ...transitionHistoryByDayPerOrderStages(newStatus, rangeStart, rangeEnd),
    ]),
    Order.aggregate([
      { $match: { ...match, ...exclude } },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      ...transitionLegacyByDayPerOrderStages(newStatus, rangeStart, rangeEnd),
    ]),
  ]);
  return mergeTransitionOrderDayRows(eventRows, historyRows, legacyRows);
}

/** Orders with vehicle / dispatch leg on dispatchHistory or assignedVehicle. */
export function matchOrderHasVehicleDispatchDetails() {
  return {
    $or: [
      { assignedVehicle: { $exists: true, $nin: [null, ""] } },
      {
        dispatchHistory: {
          $elemMatch: {
            $or: [
              { vehicleName: { $exists: true, $nin: [null, ""] } },
              { driverName: { $exists: true, $nin: [null, ""] } },
              { dispatchId: { $exists: true, $ne: null } },
            ],
          },
        },
      },
    ],
  };
}

async function aggregateTransitionsByEntityPerOrder(
  newStatus,
  rangeStart,
  rangeEnd,
  statusMatch,
  groupStages,
  groupIdFields,
  extraMatch = {}
) {
  const eventOrderIds = await distinctOrderIdsWithTransitionEvents(
    newStatus,
    rangeStart,
    rangeEnd
  );
  const exclude = transitionExcludeOrderIdsMatch(eventOrderIds);
  const match = { ...statusMatch, ...extraMatch };
  const [eventRows, historyRows, legacyRows] = await Promise.all([
    OrderEvent.aggregate(
      transitionEventsByEntityPerOrderStages(
        newStatus,
        rangeStart,
        rangeEnd,
        match,
        groupIdFields,
        groupStages
      )
    ),
    Order.aggregate([
      { $match: { ...match, ...exclude } },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      ...transitionHistoryByEntityPerOrderStages(
        newStatus,
        rangeStart,
        rangeEnd,
        groupIdFields,
        groupStages
      ),
    ]),
    Order.aggregate([
      { $match: { ...match, ...exclude } },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      ...transitionLegacyByEntityPerOrderStages(
        newStatus,
        rangeStart,
        rangeEnd,
        groupIdFields,
        groupStages
      ),
    ]),
  ]);
  return mergeTransitionEntityOrderRows(eventRows, historyRows, legacyRows);
}

/**
 * Out (dispatched): exclude orders that also have Done (completed) on the same IST day.
 */
export async function aggregateDispatchedByDay(
  rangeStart,
  rangeEnd,
  statusMatch
) {
  const [dispatched, completed] = await Promise.all([
    aggregateTransitionsByDayPerOrder("DISPATCHED", rangeStart, rangeEnd, statusMatch),
    aggregateTransitionsByDayPerOrder("COMPLETED", rangeStart, rangeEnd, statusMatch),
  ]);
  const completedKeys = new Set(completed.keys());
  const filtered = new Map();
  for (const [key, entry] of dispatched) {
    if (completedKeys.has(key)) continue;
    filtered.set(key, entry);
  }
  return rollupOrderDayMapToDayTotals(filtered);
}

/**
 * Vehicle Out: same rules as Out but only orders with vehicle/dispatch details.
 */
export async function aggregateVehicleDispatchedByDay(
  rangeStart,
  rangeEnd,
  statusMatch
) {
  const vehicleMatch = matchOrderHasVehicleDispatchDetails();
  const [dispatched, completed] = await Promise.all([
    aggregateTransitionsByDayPerOrder(
      "DISPATCHED",
      rangeStart,
      rangeEnd,
      statusMatch,
      vehicleMatch
    ),
    aggregateTransitionsByDayPerOrder("COMPLETED", rangeStart, rangeEnd, statusMatch),
  ]);
  const completedKeys = new Set(completed.keys());
  const filtered = new Map();
  for (const [key, entry] of dispatched) {
    if (completedKeys.has(key)) continue;
    filtered.set(key, entry);
  }
  return rollupOrderDayMapToDayTotals(filtered);
}

/**
 * Out by entity: exclude orders that have any Done transition in the range.
 */
/** Order ids that have both Out and Done on the same IST day (count Done only). */
export async function orderIdsWithDispatchedAndCompletedSameDay(
  rangeStart,
  rangeEnd,
  statusMatch
) {
  const [dispatched, completed] = await Promise.all([
    aggregateTransitionsByDayPerOrder("DISPATCHED", rangeStart, rangeEnd, statusMatch),
    aggregateTransitionsByDayPerOrder("COMPLETED", rangeStart, rangeEnd, statusMatch),
  ]);
  const ids = new Set();
  for (const [key, entry] of dispatched) {
    if (completed.has(key)) ids.add(entry.orderId);
  }
  return [...ids];
}

export async function aggregateDispatchedByGroup(
  rangeStart,
  rangeEnd,
  statusMatch,
  groupStages,
  groupIdFields,
  extraMatch = {}
) {
  const [dispatched, completedOrderIds] = await Promise.all([
    aggregateTransitionsByEntityPerOrder(
      "DISPATCHED",
      rangeStart,
      rangeEnd,
      statusMatch,
      groupStages,
      groupIdFields,
      extraMatch
    ),
    distinctOrderIdsWithTransitionEvents("COMPLETED", rangeStart, rangeEnd),
  ]);
  const completedSet = new Set(completedOrderIds.map((id) => String(id)));
  const filtered = new Map();
  for (const [key, row] of dispatched) {
    if (completedSet.has(String(row._id.orderId))) continue;
    filtered.set(key, row);
  }
  return rollupEntityOrderMapToRows(filtered);
}

export async function aggregateVehicleDispatchedByGroup(
  rangeStart,
  rangeEnd,
  statusMatch,
  groupStages,
  groupIdFields,
  extraMatch = {}
) {
  const vehicleMatch = matchOrderHasVehicleDispatchDetails();
  const [dispatched, completedOrderIds] = await Promise.all([
    aggregateTransitionsByEntityPerOrder(
      "DISPATCHED",
      rangeStart,
      rangeEnd,
      statusMatch,
      groupStages,
      groupIdFields,
      { ...extraMatch, ...vehicleMatch }
    ),
    distinctOrderIdsWithTransitionEvents("COMPLETED", rangeStart, rangeEnd),
  ]);
  const completedSet = new Set(completedOrderIds.map((id) => String(id)));
  const filtered = new Map();
  for (const [key, row] of dispatched) {
    if (completedSet.has(String(row._id.orderId))) continue;
    filtered.set(key, row);
  }
  return rollupEntityOrderMapToRows(filtered);
}

export async function aggregateTransitionsByDay(
  newStatus,
  rangeStart,
  rangeEnd,
  statusMatch
) {
  const eventOrderIds = await distinctOrderIdsWithTransitionEvents(
    newStatus,
    rangeStart,
    rangeEnd
  );
  const exclude = transitionExcludeOrderIdsMatch(eventOrderIds);
  const [eventRows, historyRows, legacyRows] = await Promise.all([
    aggregateTransitionEventsByDay(newStatus, rangeStart, rangeEnd, statusMatch),
    Order.aggregate([
      { $match: { ...statusMatch, ...exclude } },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      ...transitionHistoryByDayStages(newStatus, rangeStart, rangeEnd),
    ]),
    Order.aggregate([
      { $match: { ...statusMatch, ...exclude } },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      ...transitionLegacyByDayStages(newStatus, rangeStart, rangeEnd),
    ]),
  ]);
  return mergeTransitionDayRows(eventRows, historyRows, legacyRows);
}

/** Delivery in range — any status — by delivery day. */
export async function aggregateDeliveryInRangeByDay(
  rangeStart,
  rangeEnd,
  statusMatch,
  extraMatch = {}
) {
  const rows = await Order.aggregate([
    {
      $match: {
        ...statusMatch,
        ...extraMatch,
        ...matchDeliveryDateInRange(rangeStart, rangeEnd),
      },
    },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    {
      $group: {
        _id: {
          day: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$deliveryDate",
              timezone: IST,
            },
          },
        },
        orders: { $sum: 1 },
        plants: { $sum: "$linePlantTotal" },
      },
    },
  ]);
  return rowsToDayMap(rows);
}

/** Dispatch process / partial / other by delivery day + current status. */
export async function aggregatePipelineByDeliveryDay(
  rangeStart,
  rangeEnd,
  statusMatch,
  extraMatch = {}
) {
  const activeInRangeStatuses = ["DISPATCH_PROCESS", "PARTIALLY_COMPLETED"];
  const rows = await Order.aggregate([
    {
      $match: {
        ...statusMatch,
        ...extraMatch,
        orderStatus: { $in: PIPELINE_DELIVERY_STATUSES },
        $or: [
          { deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null } },
          {
            orderStatus: { $in: activeInRangeStatuses },
            updatedAt: { $gte: rangeStart, $lte: rangeEnd },
          },
        ],
      },
    },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    {
      $group: {
        _id: {
          day: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$deliveryDate",
              timezone: IST,
            },
          },
          status: "$orderStatus",
        },
        orders: { $sum: 1 },
        plants: { $sum: "$linePlantTotal" },
        plantsRemaining: {
          $sum: {
            $cond: [
              { $in: ["$orderStatus", REMAINING_STATUSES] },
              { $ifNull: ["$remainingPlants", 0] },
              0,
            ],
          },
        },
      },
    },
  ]);

  const byDay = new Map();
  for (const row of rows) {
    const day = row._id?.day;
    const status = row._id?.status;
    if (!day || !status) continue;
    if (!byDay.has(day)) {
      byDay.set(day, {
        dispatchProcess: emptyOrderPlants(),
        partiallyCompleted: { orders: 0, plants: 0, plantsRemaining: 0 },
        other: emptyOrderPlants(),
      });
    }
    const slot = byDay.get(day);
    if (status === "DISPATCH_PROCESS") {
      slot.dispatchProcess.orders += row.orders || 0;
      slot.dispatchProcess.plants += row.plants || 0;
      slot.dispatchProcess.plantsRemaining =
        (slot.dispatchProcess.plantsRemaining || 0) +
        (row.plantsRemaining || 0);
    } else if (status === "PARTIALLY_COMPLETED") {
      slot.partiallyCompleted.orders += row.orders || 0;
      slot.partiallyCompleted.plants += row.plants || 0;
      slot.partiallyCompleted.plantsRemaining += row.plantsRemaining || 0;
    } else {
      slot.other.orders += row.orders || 0;
      slot.other.plants += row.plants || 0;
    }
  }
  return byDay;
}

/**
 * Delivery total (range): unique orders where
 * delivery in range (not DISPATCHED) OR FARM_READY OR READY_FOR_DISPATCH.
 */
export async function aggregateDeliveryUnionTotal(
  rangeStart,
  rangeEnd,
  statusMatch
) {
  const rows = await Order.aggregate([
    { $match: statusMatch },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    {
      $match: {
        $or: [
          matchDeliveryDateInRange(rangeStart, rangeEnd),
          { orderStatus: "FARM_READY" },
          { orderStatus: "READY_FOR_DISPATCH" },
        ],
      },
    },
    {
      $group: {
        _id: "$_id",
        plants: { $first: "$linePlantTotal" },
      },
    },
    {
      $group: {
        _id: null,
        orders: { $sum: 1 },
        plants: { $sum: "$plants" },
      },
    },
  ]);
  return metricFromAgg(rows);
}

function buildDeliveryDayForDate(
  date,
  {
    globalFarmReady,
    globalRfd,
    acceptedByDay,
    dispatchedByDay,
    vehicleDispatchedByDay,
    completedByDay,
    pipelineByDay,
    deliveryInRangeByDay,
  }
) {
  const delivery = emptyDeliveryDay();
  const accepted = acceptedByDay.get(date) || emptyOrderPlants();
  const pipeline = pipelineByDay.get(date) || {
    dispatchProcess: emptyOrderPlants(),
    partiallyCompleted: { orders: 0, plants: 0, plantsRemaining: 0 },
    other: emptyOrderPlants(),
  };

  delivery.accepted = { ...accepted };
  delivery.farmReady = { ...globalFarmReady };
  delivery.readyForDispatch = { ...globalRfd };
  delivery.dispatched = { ...(dispatchedByDay.get(date) || emptyOrderPlants()) };
  delivery.vehicleDispatched = {
    ...(vehicleDispatchedByDay.get(date) || emptyOrderPlants()),
  };
  delivery.completed = { ...(completedByDay.get(date) || emptyOrderPlants()) };
  delivery.dispatchProcess = { ...pipeline.dispatchProcess };
  delivery.partiallyCompleted = { ...pipeline.partiallyCompleted };
  delivery.other = { ...pipeline.other };

  const inRange = deliveryInRangeByDay.get(date) || emptyOrderPlants();
  delivery.total = { ...inRange };

  return delivery;
}

function sumDeliveryDaysAcrossRange(days) {
  const totals = emptyDeliveryDay();
  let first = true;
  for (const day of days) {
    if (first) {
      totals.accepted = addOrderPlants(totals.accepted, day.delivery.accepted);
      totals.farmReady = { ...day.delivery.farmReady };
      totals.readyForDispatch = { ...day.delivery.readyForDispatch };
      totals.dispatched = addOrderPlants(totals.dispatched, day.delivery.dispatched);
      totals.vehicleDispatched = addOrderPlants(
        totals.vehicleDispatched,
        day.delivery.vehicleDispatched
      );
      totals.completed = addOrderPlants(totals.completed, day.delivery.completed);
      totals.dispatchProcess = addOrderPlants(
        totals.dispatchProcess,
        day.delivery.dispatchProcess
      );
      totals.partiallyCompleted = {
        orders:
          (totals.partiallyCompleted.orders || 0) +
          (day.delivery.partiallyCompleted.orders || 0),
        plants:
          (totals.partiallyCompleted.plants || 0) +
          (day.delivery.partiallyCompleted.plants || 0),
        plantsRemaining:
          (totals.partiallyCompleted.plantsRemaining || 0) +
          (day.delivery.partiallyCompleted.plantsRemaining || 0),
      };
      totals.other = addOrderPlants(totals.other, day.delivery.other);
      first = false;
    } else {
      totals.accepted = addOrderPlants(totals.accepted, day.delivery.accepted);
      totals.dispatched = addOrderPlants(totals.dispatched, day.delivery.dispatched);
      totals.vehicleDispatched = addOrderPlants(
        totals.vehicleDispatched,
        day.delivery.vehicleDispatched
      );
      totals.completed = addOrderPlants(totals.completed, day.delivery.completed);
      totals.dispatchProcess = addOrderPlants(
        totals.dispatchProcess,
        day.delivery.dispatchProcess
      );
      totals.partiallyCompleted = {
        orders:
          (totals.partiallyCompleted.orders || 0) +
          (day.delivery.partiallyCompleted.orders || 0),
        plants:
          (totals.partiallyCompleted.plants || 0) +
          (day.delivery.partiallyCompleted.plants || 0),
        plantsRemaining:
          (totals.partiallyCompleted.plantsRemaining || 0) +
          (day.delivery.partiallyCompleted.plantsRemaining || 0),
      };
      totals.other = addOrderPlants(totals.other, day.delivery.other);
    }
  }
  return totals;
}

/**
 * Build daily MIS using agreed column rules.
 */
function sumDayMapValues(dayMap) {
  const total = emptyOrderPlants();
  for (const v of dayMap.values()) {
    total.orders += v.orders || 0;
    total.plants += v.plants || 0;
  }
  return total;
}

export function buildAdminDailyMisPayloadFromMetrics({
  dateKeys,
  bookingRows = [],
  uniquePerDayRows = [],
  rangeUniqueOrders = 0,
  globalFarmReady,
  globalRfd,
  acceptedByDay,
  dispatchedByDay,
  vehicleDispatchedByDay = new Map(),
  completedByDay,
  pipelineByDay,
  deliveryInRangeByDay,
  deliveryUnionTotal,
  dueOnly = false,
}) {
  const bookingMap = bookingRowsToMap(bookingRows);
  const uniqueMap = uniqueRowsToMap(uniquePerDayRows);

  const days = dateKeys.map((date) => ({
    date,
    booking: bookingMap.get(date) || emptyOrderPlants(),
    delivery: buildDeliveryDayForDate(date, {
      globalFarmReady,
      globalRfd,
      acceptedByDay,
      dispatchedByDay,
      vehicleDispatchedByDay,
      completedByDay,
      pipelineByDay,
      deliveryInRangeByDay,
    }),
    uniqueOrders: uniqueMap.get(date) || 0,
  }));

  const totals = {
    booking: emptyOrderPlants(),
    delivery: emptyDeliveryDay(),
    uniqueOrders: rangeUniqueOrders,
  };

  for (const day of days) {
    totals.booking = addOrderPlants(totals.booking, day.booking);
  }

  const summed = sumDeliveryDaysAcrossRange(days);
  totals.delivery.accepted = summed.accepted;
  totals.delivery.farmReady = { ...globalFarmReady };
  totals.delivery.readyForDispatch = { ...globalRfd };
  totals.delivery.dispatched = summed.dispatched;
  totals.delivery.vehicleDispatched = summed.vehicleDispatched;
  totals.delivery.completed = summed.completed;
  totals.delivery.dispatchProcess = summed.dispatchProcess;
  totals.delivery.partiallyCompleted = summed.partiallyCompleted;
  totals.delivery.other = summed.other;
  totals.delivery.total = dueOnly
    ? sumDayMapValues(deliveryInRangeByDay)
    : { ...deliveryUnionTotal };

  return {
    timezone: IST,
    days,
    totals,
  };
}

export async function fetchMisMetricSlices(rangeStart, rangeEnd, { dueOnly = false } = {}) {
  const statusMatch = orderStatusExcludeMatch();
  const dueExtra = dueOnly ? duePipelineMatch() : {};

  const [
    globalFarmReady,
    globalRfd,
    acceptedByDay,
    dispatchedByDay,
    vehicleDispatchedByDay,
    completedByDay,
    pipelineByDay,
    deliveryInRangeByDay,
    deliveryUnionTotal,
  ] = await Promise.all([
    aggregateGlobalStatus("FARM_READY", statusMatch, dueExtra),
    aggregateGlobalStatus("READY_FOR_DISPATCH", statusMatch, dueExtra),
    aggregateAcceptedByDeliveryDay(rangeStart, rangeEnd, statusMatch, dueExtra),
    aggregateDispatchedByDay(rangeStart, rangeEnd, statusMatch),
    aggregateVehicleDispatchedByDay(rangeStart, rangeEnd, statusMatch),
    aggregateTransitionsByDay("COMPLETED", rangeStart, rangeEnd, statusMatch),
    aggregatePipelineByDeliveryDay(rangeStart, rangeEnd, statusMatch, dueExtra),
    aggregateDeliveryInRangeByDay(rangeStart, rangeEnd, statusMatch, dueExtra),
    dueOnly
      ? Promise.resolve({ orders: 0, plants: 0 })
      : aggregateDeliveryUnionTotal(rangeStart, rangeEnd, statusMatch),
  ]);

  return {
    globalFarmReady,
    globalRfd,
    acceptedByDay,
    dispatchedByDay,
    vehicleDispatchedByDay,
    completedByDay,
    pipelineByDay,
    deliveryInRangeByDay,
    deliveryUnionTotal,
  };
}

/** Person / variety: global status for one entity. */
export async function aggregateGlobalStatusByGroup(
  status,
  statusMatch,
  groupStages,
  groupIdFields,
  extraMatch = {}
) {
  const rows = await Order.aggregate([
    { $match: { ...statusMatch, ...extraMatch, orderStatus: status } },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    ...groupStages,
    {
      $group: {
        _id: groupIdFields,
        orders: { $sum: 1 },
        plants: { $sum: "$linePlantTotal" },
      },
    },
  ]);
  return rows;
}

export async function aggregateAcceptedByDeliveryAndGroup(
  rangeStart,
  rangeEnd,
  statusMatch,
  groupStages,
  groupIdFields,
  extraMatch = {}
) {
  const rows = await Order.aggregate([
    {
      $match: {
        ...statusMatch,
        ...extraMatch,
        orderStatus: "ACCEPTED",
        deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null },
      },
    },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    ...groupStages,
    {
      $group: {
        _id: groupIdFields,
        orders: { $sum: 1 },
        plants: { $sum: "$linePlantTotal" },
      },
    },
  ]);
  return rows;
}

export async function aggregateTransitionsByGroup(
  newStatus,
  rangeStart,
  rangeEnd,
  statusMatch,
  groupStages,
  groupIdFields,
  extraMatch = {}
) {
  const eventOrderIds = await distinctOrderIdsWithTransitionEvents(
    newStatus,
    rangeStart,
    rangeEnd
  );
  const exclude = transitionExcludeOrderIdsMatch(eventOrderIds);
  const [eventRows, historyRows, legacyRows] = await Promise.all([
    aggregateTransitionEventsByGroup(
      newStatus,
      rangeStart,
      rangeEnd,
      { ...statusMatch, ...extraMatch },
      groupStages,
      groupIdFields
    ),
    Order.aggregate([
      { $match: { ...statusMatch, ...extraMatch, ...exclude } },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      ...transitionHistoryByEntityStages(
        newStatus,
        rangeStart,
        rangeEnd,
        groupIdFields,
        groupStages
      ),
    ]),
    Order.aggregate([
      { $match: { ...statusMatch, ...extraMatch, ...exclude } },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      ...transitionLegacyByEntityStages(
        newStatus,
        rangeStart,
        rangeEnd,
        groupIdFields,
        groupStages
      ),
    ]),
  ]);

  const byKey = new Map();
  for (const row of [...eventRows, ...historyRows, ...legacyRows]) {
    const key = JSON.stringify(row._id);
    if (!byKey.has(key)) {
      byKey.set(key, { _id: row._id, orders: 0, plants: 0 });
    }
    const slot = byKey.get(key);
    slot.orders += row.orders || 0;
    slot.plants += row.plants || 0;
  }
  return [...byKey.values()];
}

/** Pipeline buckets by delivery-in-range + current status, grouped by entity. */
export async function aggregatePipelineByGroup(
  rangeStart,
  rangeEnd,
  statusMatch,
  groupStages,
  groupIdFields,
  extraMatch = {}
) {
  const activeInRangeStatuses = ["DISPATCH_PROCESS", "PARTIALLY_COMPLETED"];
  return Order.aggregate([
    {
      $match: {
        ...statusMatch,
        ...extraMatch,
        orderStatus: { $in: PIPELINE_DELIVERY_STATUSES },
        $or: [
          { deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null } },
          {
            orderStatus: { $in: activeInRangeStatuses },
            updatedAt: { $gte: rangeStart, $lte: rangeEnd },
          },
        ],
      },
    },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    ...groupStages,
    {
      $group: {
        _id: { ...groupIdFields, status: "$orderStatus" },
        orders: { $sum: 1 },
        plants: { $sum: "$linePlantTotal" },
      },
    },
  ]);
}

/** Delivery backlog before range (excludes DISPATCHED, COMPLETED) per entity. */
export async function aggregateDeliveryBeforeRangeByGroup(
  rangeStart,
  statusMatch,
  groupStages,
  groupIdFields,
  extraMatch = {}
) {
  const rows = await Order.aggregate([
    {
      $match: {
        ...statusMatch,
        ...extraMatch,
        ...matchDeliveryDateBeforeRange(rangeStart),
      },
    },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    ...groupStages,
    {
      $group: {
        _id: groupIdFields,
        orders: { $sum: 1 },
        plants: { $sum: "$linePlantTotal" },
      },
    },
  ]);
  return rows;
}

/** Delivery in range (excludes DISPATCHED, COMPLETED) per entity — variety Delivery column. */
export async function aggregateDeliveryInRangeByGroup(
  rangeStart,
  rangeEnd,
  statusMatch,
  groupStages,
  groupIdFields,
  extraMatch = {}
) {
  const rows = await Order.aggregate([
    {
      $match: {
        ...statusMatch,
        ...extraMatch,
        ...matchDeliveryDateInRange(rangeStart, rangeEnd),
      },
    },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    ...groupStages,
    {
      $group: {
        _id: groupIdFields,
        orders: { $sum: 1 },
        plants: { $sum: "$linePlantTotal" },
      },
    },
  ]);
  return rows;
}

/** Delivery union total per entity (delivery in range OR FR OR RFD). */
export async function aggregateDeliveryUnionByGroup(
  rangeStart,
  rangeEnd,
  statusMatch,
  groupStages,
  groupIdFields,
  extraMatch = {}
) {
  const rows = await Order.aggregate([
    { $match: { ...statusMatch, ...extraMatch } },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    ...groupStages,
    {
      $match: {
        $or: [
          matchDeliveryDateInRange(rangeStart, rangeEnd),
          { orderStatus: "FARM_READY" },
          { orderStatus: "READY_FOR_DISPATCH" },
        ],
      },
    },
    {
      $group: {
        _id: { ...groupIdFields, orderId: "$_id" },
        plants: { $first: "$linePlantTotal" },
      },
    },
    {
      $group: {
        _id: groupIdFields,
        orders: { $sum: 1 },
        plants: { $sum: "$plants" },
      },
    },
  ]);
  return rows;
}

function metricsRowsToMap(rows, keyFn) {
  const map = new Map();
  for (const row of rows || []) {
    const key = keyFn(row);
    if (key == null) continue;
    map.set(key, { orders: row.orders || 0, plants: row.plants || 0 });
  }
  return map;
}

/** Resolve display labels from any metric aggregation row (not only booking). */
function buildLabelMetaByKey(rowSets, entityKeyFn) {
  const map = new Map();
  for (const rows of rowSets) {
    for (const row of rows || []) {
      const key = entityKeyFn(row);
      if (!key || map.has(key)) continue;
      const id = row._id ?? row;
      map.set(key, id);
    }
  }
  return map;
}

/**
 * Merge person/dealer breakdown rows with new metric rules.
 */
export function buildBreakdownTableFromMetrics({
  bookingRows = [],
  entityKeyFn,
  labelFromKey,
  globalFarmReadyRows = [],
  globalRfdRows = [],
  acceptedRows = [],
  dispatchedRows = [],
  vehicleDispatchedRows = [],
  completedRows = [],
  pipelineRows = [],
  deliveryUnionRows = [],
  /** Pass an array (may be empty) to use in-range delivery only for delivery.total (variety table). */
  deliveryInRangeRows = null,
}) {
  const farmReadyMap = metricsRowsToMap(globalFarmReadyRows, entityKeyFn);
  const rfdMap = metricsRowsToMap(globalRfdRows, entityKeyFn);
  const acceptedMap = metricsRowsToMap(acceptedRows, entityKeyFn);
  const dispatchedMap = metricsRowsToMap(dispatchedRows, entityKeyFn);
  const vehicleDispatchedMap = metricsRowsToMap(vehicleDispatchedRows, entityKeyFn);
  const completedMap = metricsRowsToMap(completedRows, entityKeyFn);
  const unionMap = metricsRowsToMap(deliveryUnionRows, entityKeyFn);
  const inRangeMap = metricsRowsToMap(deliveryInRangeRows || [], entityKeyFn);
  const deliveryTotalMap =
    deliveryInRangeRows != null ? inRangeMap : unionMap;

  const pipelineMap = new Map();
  for (const row of pipelineRows || []) {
    const key = entityKeyFn(row);
    if (!key) continue;
    if (!pipelineMap.has(key)) {
      pipelineMap.set(key, {
        dispatchProcess: emptyOrderPlants(),
        partiallyCompleted: emptyOrderPlants(),
        other: emptyOrderPlants(),
      });
    }
    const status = row._id?.status;
    const slot = pipelineMap.get(key);
    if (status === "DISPATCH_PROCESS") {
      slot.dispatchProcess.orders += row.orders || 0;
      slot.dispatchProcess.plants += row.plants || 0;
    } else if (status === "PARTIALLY_COMPLETED") {
      slot.partiallyCompleted.orders += row.orders || 0;
      slot.partiallyCompleted.plants += row.plants || 0;
    } else {
      slot.other.orders += row.orders || 0;
      slot.other.plants += row.plants || 0;
    }
  }

  const keys = new Set();
  for (const row of bookingRows || []) keys.add(entityKeyFn(row));
  for (const key of farmReadyMap.keys()) keys.add(key);
  for (const key of rfdMap.keys()) keys.add(key);
  for (const key of acceptedMap.keys()) keys.add(key);
  for (const key of dispatchedMap.keys()) keys.add(key);
  for (const key of vehicleDispatchedMap.keys()) keys.add(key);
  for (const key of completedMap.keys()) keys.add(key);
  for (const key of unionMap.keys()) keys.add(key);
  if (deliveryInRangeRows != null) {
    for (const key of inRangeMap.keys()) keys.add(key);
  }

  const labelMetaByKey = buildLabelMetaByKey(
    [
      bookingRows,
      globalFarmReadyRows,
      globalRfdRows,
      acceptedRows,
      dispatchedRows,
      vehicleDispatchedRows,
      completedRows,
      pipelineRows,
      deliveryUnionRows,
      deliveryInRangeRows,
    ],
    entityKeyFn
  );

  const rows = [];
  for (const key of keys) {
    if (!key) continue;
    const booking = (bookingRows || []).find((r) => entityKeyFn(r) === key);
    const pipeline = pipelineMap.get(key) || {
      dispatchProcess: emptyOrderPlants(),
      partiallyCompleted: emptyOrderPlants(),
      other: emptyOrderPlants(),
    };
    const meta = labelFromKey(key, booking, labelMetaByKey.get(key));

    rows.push({
      ...meta,
      booking: {
        orders: booking?.bookingOrders || 0,
        plants: booking?.bookingPlants || 0,
      },
      delivery: {
        total: deliveryTotalMap.get(key) || emptyOrderPlants(),
        accepted: acceptedMap.get(key) || emptyOrderPlants(),
        farmReady: farmReadyMap.get(key) || emptyOrderPlants(),
        readyForDispatch: rfdMap.get(key) || emptyOrderPlants(),
        dispatchProcess: pipeline.dispatchProcess,
        partiallyCompleted: pipeline.partiallyCompleted,
        dispatched: dispatchedMap.get(key) || emptyOrderPlants(),
        vehicleDispatched: vehicleDispatchedMap.get(key) || emptyOrderPlants(),
        completed: completedMap.get(key) || emptyOrderPlants(),
        other: pipeline.other,
      },
    });
  }

  rows.sort((a, b) => {
    const plantCmp = String(a.plantName || "").localeCompare(String(b.plantName || ""));
    if (plantCmp !== 0) return plantCmp;
    const subCmp = String(a.subtype || "").localeCompare(String(b.subtype || ""));
    if (subCmp !== 0) return subCmp;
    return String(a.personName || "").localeCompare(String(b.personName || ""));
  });

  const totals = {
    booking: emptyOrderPlants(),
    delivery: emptyDeliveryDay(),
  };
  for (const row of rows) {
    totals.booking = addOrderPlants(totals.booking, row.booking);
    totals.delivery.accepted = addOrderPlants(
      totals.delivery.accepted,
      row.delivery.accepted
    );
    totals.delivery.dispatched = addOrderPlants(
      totals.delivery.dispatched,
      row.delivery.dispatched
    );
    totals.delivery.vehicleDispatched = addOrderPlants(
      totals.delivery.vehicleDispatched,
      row.delivery.vehicleDispatched
    );
    totals.delivery.completed = addOrderPlants(
      totals.delivery.completed,
      row.delivery.completed
    );
    totals.delivery.dispatchProcess = addOrderPlants(
      totals.delivery.dispatchProcess,
      row.delivery.dispatchProcess
    );
    totals.delivery.partiallyCompleted = addOrderPlants(
      totals.delivery.partiallyCompleted,
      row.delivery.partiallyCompleted
    );
    totals.delivery.other = addOrderPlants(totals.delivery.other, row.delivery.other);
  }
  totals.delivery.farmReady = rows.reduce(
    (acc, r) => addOrderPlants(acc, r.delivery.farmReady),
    emptyOrderPlants()
  );
  totals.delivery.readyForDispatch = rows.reduce(
    (acc, r) => addOrderPlants(acc, r.delivery.readyForDispatch),
    emptyOrderPlants()
  );
  totals.delivery.total = rows.reduce(
    (acc, r) => addOrderPlants(acc, r.delivery.total),
    emptyOrderPlants()
  );

  return { rows, totals };
}

const VARIETY_GROUP_ID = {
  plantName: { $ifNull: ["$_plantTypeName", "Unknown"] },
  subtype: "$_subtypeName",
  plantId: "$plantName",
  subtypeId: "$plantSubtype",
};

function varietyEntityKey(row) {
  const id = row._id ?? row;
  const plantId = id.plantId ?? row.plantId;
  const subtypeId = id.subtypeId ?? row.subtypeId;
  if (plantId == null || subtypeId == null) return "";
  return `${String(plantId)}:${String(subtypeId)}`;
}

function varietyLabelFromKey(key, booking, metricMeta) {
  const id = metricMeta ?? booking?._id ?? booking ?? {};
  const parts = String(key).split(":");
  return {
    plantName: booking?.plantName ?? id.plantName ?? "Unknown",
    subtype: booking?.subtype ?? id.subtype ?? "Other",
    plantId: booking?.plantId ?? id.plantId ?? parts[0],
    subtypeId: booking?.subtypeId ?? id.subtypeId ?? parts[1],
  };
}

function rowToVarietyBookingShape(row) {
  const id = row._id ?? row;
  return {
    plantName: id.plantName,
    subtype: id.subtype,
    plantId: id.plantId,
    subtypeId: id.subtypeId,
    bookingOrders: row.bookingOrders ?? row.orders ?? 0,
    bookingPlants: row.bookingPlants ?? row.plants ?? 0,
  };
}

/** Variety breakdown — same metric rules as daily MIS; Delivery = in-range only (no DISPATCHED). */
export async function fetchVarietyTableMetrics(
  rangeStart,
  rangeEnd,
  groupStages,
  { dueOnly = false } = {}
) {
  const statusMatch = orderStatusExcludeMatch();
  const dueExtra = dueOnly ? duePipelineMatch() : {};

  const [
    bookingRows,
    globalFarmReadyRows,
    globalRfdRows,
    acceptedRows,
    dispatchedRows,
    vehicleDispatchedRows,
    completedRows,
    pipelineRows,
    deliveryInRangeRows,
  ] = await Promise.all([
    Order.aggregate([
      {
        $match: {
          ...statusMatch,
          orderBookingDate: { $gte: rangeStart, $lte: rangeEnd },
        },
      },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      ...groupStages,
      {
        $group: {
          _id: VARIETY_GROUP_ID,
          bookingOrders: { $sum: 1 },
          bookingPlants: { $sum: "$linePlantTotal" },
        },
      },
    ]),
    aggregateGlobalStatusByGroup(
      "FARM_READY",
      statusMatch,
      groupStages,
      VARIETY_GROUP_ID,
      dueExtra
    ),
    aggregateGlobalStatusByGroup(
      "READY_FOR_DISPATCH",
      statusMatch,
      groupStages,
      VARIETY_GROUP_ID,
      dueExtra
    ),
    aggregateAcceptedByDeliveryAndGroup(
      rangeStart,
      rangeEnd,
      statusMatch,
      groupStages,
      VARIETY_GROUP_ID,
      dueExtra
    ),
    aggregateDispatchedByGroup(
      rangeStart,
      rangeEnd,
      statusMatch,
      groupStages,
      VARIETY_GROUP_ID,
      dueExtra
    ),
    aggregateVehicleDispatchedByGroup(
      rangeStart,
      rangeEnd,
      statusMatch,
      groupStages,
      VARIETY_GROUP_ID,
      dueExtra
    ),
    aggregateTransitionsByGroup(
      "COMPLETED",
      rangeStart,
      rangeEnd,
      statusMatch,
      groupStages,
      VARIETY_GROUP_ID,
      dueExtra
    ),
    aggregatePipelineByGroup(
      rangeStart,
      rangeEnd,
      statusMatch,
      groupStages,
      VARIETY_GROUP_ID,
      dueExtra
    ),
    aggregateDeliveryInRangeByGroup(
      rangeStart,
      rangeEnd,
      statusMatch,
      groupStages,
      VARIETY_GROUP_ID,
      dueExtra
    ),
  ]);

  return buildBreakdownTableFromMetrics({
    bookingRows: bookingRows.map(rowToVarietyBookingShape),
    entityKeyFn: varietyEntityKey,
    labelFromKey: varietyLabelFromKey,
    globalFarmReadyRows,
    globalRfdRows,
    acceptedRows,
    dispatchedRows,
    vehicleDispatchedRows,
    completedRows,
    pipelineRows,
    deliveryInRangeRows,
    deliveryUnionRows: [],
  });
}

function backlogOrderExtra(rangeStart) {
  return {
    ...duePipelineMatch(),
    deliveryDate: { $lt: rangeStart, $ne: null },
  };
}

/**
 * Entity breakdown for orders due before range start (per plant, sales person, etc.).
 */
export async function fetchEntityPastDueBreakdown(
  rangeStart,
  {
    groupStages,
    groupIdFields,
    entityKeyFn,
    labelFromKey,
    extraMatch = {},
    dueOnly = false,
  }
) {
  const statusMatch = orderStatusExcludeMatch();
  const backlogExtra = {
    ...backlogOrderExtra(rangeStart),
    ...extraMatch,
    ...(dueOnly ? duePipelineMatch() : {}),
  };

  const pipelineRows = await Order.aggregate([
    {
      $match: {
        ...statusMatch,
        ...backlogExtra,
        orderStatus: { $in: PIPELINE_DELIVERY_STATUSES },
      },
    },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    ...groupStages,
    {
      $group: {
        _id: { ...groupIdFields, status: "$orderStatus" },
        orders: { $sum: 1 },
        plants: { $sum: "$linePlantTotal" },
        plantsRemaining: {
          $sum: {
            $cond: [
              { $in: ["$orderStatus", REMAINING_STATUSES] },
              { $ifNull: ["$remainingPlants", 0] },
              0,
            ],
          },
        },
      },
    },
  ]);

  const [globalFarmReadyRows, globalRfdRows, acceptedRows, deliveryBacklogRows] =
    await Promise.all([
      aggregateGlobalStatusByGroup(
        "FARM_READY",
        statusMatch,
        groupStages,
        groupIdFields,
        backlogExtra
      ),
      aggregateGlobalStatusByGroup(
        "READY_FOR_DISPATCH",
        statusMatch,
        groupStages,
        groupIdFields,
        backlogExtra
      ),
      Order.aggregate([
        {
          $match: {
            ...statusMatch,
            ...backlogExtra,
            orderStatus: "ACCEPTED",
          },
        },
        { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
        ...groupStages,
        {
          $group: {
            _id: groupIdFields,
            orders: { $sum: 1 },
            plants: { $sum: "$linePlantTotal" },
          },
        },
      ]),
      aggregateDeliveryBeforeRangeByGroup(
        rangeStart,
        statusMatch,
        groupStages,
        groupIdFields,
        backlogExtra
      ),
    ]);

  return buildBreakdownTableFromMetrics({
    bookingRows: [],
    entityKeyFn,
    labelFromKey,
    globalFarmReadyRows,
    globalRfdRows,
    acceptedRows,
    dispatchedRows: [],
    completedRows: [],
    pipelineRows,
    deliveryInRangeRows: deliveryBacklogRows,
    deliveryUnionRows: [],
  });
}

/** Variety table metrics for backlog (delivery date before range). */
export async function fetchVarietyPastDueTableMetrics(
  rangeStart,
  groupStages,
  { dueOnly = false } = {}
) {
  return fetchEntityPastDueBreakdown(rangeStart, {
    groupStages,
    groupIdFields: VARIETY_GROUP_ID,
    entityKeyFn: varietyEntityKey,
    labelFromKey: varietyLabelFromKey,
    mapBookingRow: rowToVarietyBookingShape,
    dueOnly,
  });
}

function breakdownEntityKey(row) {
  if (row.plantId != null && row.subtypeId != null) {
    return `${row.plantId}:${row.subtypeId}`;
  }
  if (row.personId != null) return String(row.personId);
  return "";
}

/**
 * Attach per-entity pastDue delivery buckets for includeAllPastDue UI (in-range + backlog per cell).
 */
export function mergeBreakdownWithPastDue(inRangeTable, pastDueTable) {
  const emptyDelivery = emptyDeliveryDay();
  const byKey = new Map();

  for (const row of inRangeTable?.rows || []) {
    byKey.set(breakdownEntityKey(row), { ...row, pastDue: null });
  }

  for (const row of pastDueTable?.rows || []) {
    const key = breakdownEntityKey(row);
    if (!key) continue;
    if (byKey.has(key)) {
      byKey.get(key).pastDue = row.delivery;
    } else {
      byKey.set(key, {
        ...row,
        booking: { orders: 0, plants: 0 },
        delivery: emptyDelivery,
        pastDue: row.delivery,
      });
    }
  }

  const rows = [...byKey.values()];
  rows.sort((a, b) => {
    const plantCmp = String(a.plantName || a.personName || "").localeCompare(
      String(b.plantName || b.personName || "")
    );
    if (plantCmp !== 0) return plantCmp;
    return String(a.subtype || "").localeCompare(String(b.subtype || ""));
  });

  return {
    rows,
    totals: {
      ...(inRangeTable?.totals || { booking: emptyOrderPlants(), delivery: emptyDelivery }),
      pastDue: pastDueTable?.totals?.delivery || emptyDelivery,
    },
  };
}

export { istDateStringExpr };
