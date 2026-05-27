import Order from "../models/order.model.js";
import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
  ORDER_EXCLUDED_STATUSES,
  istDateStringExpr,
} from "./istOrderDateStats.js";

/** Not counted in Delivery column — use Out (Dispatched) instead. */
export const DELIVERY_TOTAL_EXCLUDED_STATUSES = ["DISPATCHED"];

/** Delivery date in IST range, excluding cancelled/rejected and dispatched. */
export function matchDeliveryDateInRange(rangeStart, rangeEnd) {
  return {
    deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null },
    orderStatus: {
      $nin: [...ORDER_EXCLUDED_STATUSES, ...DELIVERY_TOTAL_EXCLUDED_STATUSES],
    },
  };
}
import {
  emptyOrderPlants,
  emptyDeliveryDay,
  bookingRowsToMap,
  uniqueRowsToMap,
  addOrderPlants,
  addDeliveryDays,
} from "./adminDailyMisMerge.js";

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
export async function aggregateGlobalStatus(status, statusMatch) {
  const rows = await Order.aggregate([
    { $match: { ...statusMatch, orderStatus: status } },
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
  statusMatch
) {
  const rows = await Order.aggregate([
    {
      $match: {
        ...statusMatch,
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

/** statusChanges → newStatus on IST day (one row per order per day). */
export async function aggregateTransitionsByDay(
  newStatus,
  rangeStart,
  rangeEnd,
  statusMatch
) {
  const rows = await Order.aggregate([
    { $match: statusMatch },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    { $unwind: "$statusChanges" },
    {
      $match: {
        "statusChanges.newStatus": newStatus,
        "statusChanges.createdAt": { $gte: rangeStart, $lte: rangeEnd },
      },
    },
    {
      $group: {
        _id: {
          day: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$statusChanges.createdAt",
              timezone: IST,
            },
          },
          orderId: "$_id",
        },
        plants: { $first: "$linePlantTotal" },
      },
    },
    {
      $group: {
        _id: "$_id.day",
        orders: { $sum: 1 },
        plants: { $sum: "$plants" },
      },
    },
  ]);
  return rowsToDayMap(rows);
}

/** Delivery in range — any status — by delivery day. */
export async function aggregateDeliveryInRangeByDay(
  rangeStart,
  rangeEnd,
  statusMatch
) {
  const rows = await Order.aggregate([
    {
      $match: {
        ...statusMatch,
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
  statusMatch
) {
  const rows = await Order.aggregate([
    {
      $match: {
        ...statusMatch,
        orderStatus: { $in: PIPELINE_DELIVERY_STATUSES },
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
export function buildAdminDailyMisPayloadFromMetrics({
  dateKeys,
  bookingRows = [],
  uniquePerDayRows = [],
  rangeUniqueOrders = 0,
  globalFarmReady,
  globalRfd,
  acceptedByDay,
  dispatchedByDay,
  completedByDay,
  pipelineByDay,
  deliveryInRangeByDay,
  deliveryUnionTotal,
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
  totals.delivery.completed = summed.completed;
  totals.delivery.dispatchProcess = summed.dispatchProcess;
  totals.delivery.partiallyCompleted = summed.partiallyCompleted;
  totals.delivery.other = summed.other;
  totals.delivery.total = { ...deliveryUnionTotal };

  return {
    timezone: IST,
    days,
    totals,
  };
}

export async function fetchMisMetricSlices(rangeStart, rangeEnd) {
  const statusMatch = orderStatusExcludeMatch();

  const [
    globalFarmReady,
    globalRfd,
    acceptedByDay,
    dispatchedByDay,
    completedByDay,
    pipelineByDay,
    deliveryInRangeByDay,
    deliveryUnionTotal,
  ] = await Promise.all([
    aggregateGlobalStatus("FARM_READY", statusMatch),
    aggregateGlobalStatus("READY_FOR_DISPATCH", statusMatch),
    aggregateAcceptedByDeliveryDay(rangeStart, rangeEnd, statusMatch),
    aggregateTransitionsByDay("DISPATCHED", rangeStart, rangeEnd, statusMatch),
    aggregateTransitionsByDay("COMPLETED", rangeStart, rangeEnd, statusMatch),
    aggregatePipelineByDeliveryDay(rangeStart, rangeEnd, statusMatch),
    aggregateDeliveryInRangeByDay(rangeStart, rangeEnd, statusMatch),
    aggregateDeliveryUnionTotal(rangeStart, rangeEnd, statusMatch),
  ]);

  return {
    globalFarmReady,
    globalRfd,
    acceptedByDay,
    dispatchedByDay,
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
  const rows = await Order.aggregate([
    { $match: { ...statusMatch, ...extraMatch } },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    ...groupStages,
    { $unwind: "$statusChanges" },
    {
      $match: {
        "statusChanges.newStatus": newStatus,
        "statusChanges.createdAt": { $gte: rangeStart, $lte: rangeEnd },
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

/** Pipeline buckets by delivery-in-range + current status, grouped by entity. */
export async function aggregatePipelineByGroup(
  rangeStart,
  rangeEnd,
  statusMatch,
  groupStages,
  groupIdFields,
  extraMatch = {}
) {
  return Order.aggregate([
    {
      $match: {
        ...statusMatch,
        ...extraMatch,
        orderStatus: { $in: PIPELINE_DELIVERY_STATUSES },
        deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null },
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
  pipelineRows = [],
  deliveryUnionRows = [],
}) {
  const farmReadyMap = metricsRowsToMap(globalFarmReadyRows, entityKeyFn);
  const rfdMap = metricsRowsToMap(globalRfdRows, entityKeyFn);
  const acceptedMap = metricsRowsToMap(acceptedRows, entityKeyFn);
  const dispatchedMap = metricsRowsToMap(dispatchedRows, entityKeyFn);
  const unionMap = metricsRowsToMap(deliveryUnionRows, entityKeyFn);

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
  for (const key of unionMap.keys()) keys.add(key);

  const rows = [];
  for (const key of keys) {
    if (!key) continue;
    const booking = (bookingRows || []).find((r) => entityKeyFn(r) === key);
    const pipeline = pipelineMap.get(key) || {
      dispatchProcess: emptyOrderPlants(),
      partiallyCompleted: emptyOrderPlants(),
      other: emptyOrderPlants(),
    };
    const meta = labelFromKey(key, booking);

    rows.push({
      ...meta,
      booking: {
        orders: booking?.bookingOrders || 0,
        plants: booking?.bookingPlants || 0,
      },
      delivery: {
        total: unionMap.get(key) || emptyOrderPlants(),
        accepted: acceptedMap.get(key) || emptyOrderPlants(),
        farmReady: farmReadyMap.get(key) || emptyOrderPlants(),
        readyForDispatch: rfdMap.get(key) || emptyOrderPlants(),
        dispatchProcess: pipeline.dispatchProcess,
        partiallyCompleted: pipeline.partiallyCompleted,
        dispatched: dispatchedMap.get(key) || emptyOrderPlants(),
        completed: emptyOrderPlants(),
        other: pipeline.other,
      },
    });
  }

  rows.sort((a, b) =>
    String(a.personName || a.plantName || "").localeCompare(
      String(b.personName || b.plantName || "")
    )
  );

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

export { istDateStringExpr };
