/**
 * Daily past-due slot rollover: move open-pipeline orders off expired booking slots
 * to the first **active** (non-expired) slot — skips intermediate expired windows.
 * Delivery = target slot end day (IST).
 *
 * Optimized: 1× PlantSlot load + 1× Order query + in-memory slot lookup (no per-slot DB).
 */

import moment from "moment";
import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import { DUE_DELIVERY_STATUSES } from "../utility/adminMisDue.js";
import {
  getSlotWindowById,
  isDateOutsideSlotWindow,
} from "../utility/findDeliverySlot.js";
import { SLOT_TRAIL_ACTIONS } from "../constants/slotTrailActions.js";
import {
  moveOrderBetweenSlots,
  appendSlotTrail,
} from "./earlyDispatch.service.js";
import {
  deliveryDateFromSlotEnd,
  deliveryDateFromSlotStart,
} from "./whatsappFarmReadySlot.service.js";
import { emitPlantOrderUpdateEvents } from "../utils/orderEventDualWrite.js";
import {
  ORDER_DOMAINS,
  ORDER_EVENT_TYPES,
  ORDER_EVENT_SOURCE,
  buildIdempotencyKey,
  emitOrderEvent,
} from "../modules/orderEvents/index.js";

/** Mirror rollover into OrderEvent (order activity timeline). */
export async function emitPastDueRolloverTimelineEvents(orderId, timelinePayload) {
  if (!orderId || !timelinePayload?.deliveryChange) return;
  const { deliveryChange, occurredAt, slotLabel } = timelinePayload;
  const at = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  const correlationId = `past-due-rollover:${orderId}:${at.getTime()}`;

  await emitPlantOrderUpdateEvents({
    orderId,
    deliveryChange,
    actorName: "Past-due slot rollover",
    correlationId,
  });

  await emitOrderEvent({
    orderDomain: ORDER_DOMAINS.PLANT,
    orderId,
    eventType: ORDER_EVENT_TYPES.ORDER_FIELD_CHANGED,
    field: "pastDueSlotRollover",
    previousValue: false,
    newValue: true,
    description: slotLabel || "Past-due slot rollover",
    actorName: "Past-due slot rollover",
    reason: deliveryChange.reasonForChange,
    occurredAt: at,
    correlationId,
    idempotencyKey: buildIdempotencyKey(
      "plant",
      "past-due-rollover",
      orderId,
      at.getTime()
    ),
    source: ORDER_EVENT_SOURCE.LIVE,
  });
}

const IST_OFFSET = "+05:30";

const OPEN_PIPELINE_STATUSES = DUE_DELIVERY_STATUSES;

const ORDER_SELECT =
  "_id orderId numberOfPlants additionalPlants bookingSlot deliveryDate orderStatus quotaSource productMappingId productName dispatchedFromAnotherSlot oldDeliveryDate originalBookingSlot pastDueSlotRollover";

const STATUS_ORDER = [
  "PENDING",
  "PROCESSING",
  "ACCEPTED",
  "ASSIGNED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
];

function bumpBucket(map, key, plants) {
  const k = key || "Unknown";
  if (!map[k]) map[k] = { orders: 0, plants: 0 };
  map[k].orders += 1;
  map[k].plants += plants;
}

function sortStatusKeys(byStatus) {
  const keys = Object.keys(byStatus);
  return keys.sort((a, b) => {
    const ia = STATUS_ORDER.indexOf(a);
    const ib = STATUS_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

function finalizeBreakdown(byStatus) {
  const statusRows = sortStatusKeys(byStatus).map((status) => ({
    status,
    ...byStatus[status],
  }));
  const totals = statusRows.reduce(
    (acc, row) => ({
      orders: acc.orders + row.orders,
      plants: acc.plants + row.plants,
    }),
    { orders: 0, plants: 0 }
  );
  return { byOrderStatus: statusRows, totals };
}

const PLANT_SLOT_SELECT = {
  plantId: 1,
  year: 1,
  "subtypeSlots.subtypeId": 1,
  "subtypeSlots.slots": 1,
};

function orderPlantCount(order) {
  return (Number(order.numberOfPlants) || 0) + (Number(order.additionalPlants) || 0);
}

function slotStartMoment(slot) {
  return moment(slot.startDay, "DD-MM-YYYY").utcOffset(IST_OFFSET).startOf("day");
}

function slotEndMoment(slot) {
  return moment(slot.endDay, "DD-MM-YYYY").utcOffset(IST_OFFSET).endOf("day");
}

function asOfStartOfDay(asOfDate) {
  return moment(asOfDate).utcOffset(IST_OFFSET).startOf("day");
}

function plantSubtypeKey(plantId, subtypeId) {
  return `${String(plantId)}:${String(subtypeId)}`;
}

export function isSlotExpiredByEndDay(slot, asOfDate = new Date()) {
  if (!slot?.endDay) return false;
  const end = slotEndMoment(slot);
  return end.isBefore(asOfStartOfDay(asOfDate), "day");
}

/** Slot window still open for booking / rollover as of date. */
export function isSlotActive(slot, asOfDate = new Date()) {
  return !isSlotExpiredByEndDay(slot, asOfDate);
}

/** True when asOf falls inside slot start–end (IST calendar days). */
export function isSlotContainingDate(slot, asOfDate = new Date()) {
  if (!slot?.startDay || !slot?.endDay) return false;
  const d = asOfStartOfDay(asOfDate);
  const start = slotStartMoment(slot);
  const end = slotEndMoment(slot);
  return d.isSameOrAfter(start, "day") && d.isSameOrBefore(end, "day");
}

/**
 * The slot row that should show past-due UI totals: today's window, else first active slot.
 */
export function findCurrentSlotIdForGroup(slots, asOfDate = new Date()) {
  const list = [...(slots || [])]
    .filter((s) => s?.status !== false)
    .sort((a, b) => slotStartMoment(a).valueOf() - slotStartMoment(b).valueOf());

  for (const slot of list) {
    if (isSlotContainingDate(slot, asOfDate)) {
      return slot._id?.toString?.() || String(slot._id);
    }
  }
  for (const slot of list) {
    if (isSlotActive(slot, asOfDate)) {
      return slot._id?.toString?.() || String(slot._id);
    }
  }
  return null;
}

/**
 * Delivery for rollover target: **today** when today is inside the slot (e.g. 6 Jul in 1–15 Jul window),
 * else slot end for upcoming windows.
 */
export function deliveryDateForRolloverTarget(slot, asOfDate = new Date()) {
  if (isSlotContainingDate(slot, asOfDate)) {
    return asOfStartOfDay(asOfDate).toDate();
  }
  return deliveryDateFromSlotEnd(slot) || deliveryDateFromSlotStart(slot);
}

/** @deprecated alias */
export function deliveryDateForActiveSlot(slot, asOfDate = new Date()) {
  return deliveryDateForRolloverTarget(slot, asOfDate);
}

/**
 * Build slot lookup maps from one PlantSlot lean load.
 */
export function buildSlotRolloverIndexes(plantSlots, asOfDate = new Date()) {
  const slotById = new Map();
  const slotsByPlantSubtype = new Map();
  const expiredSlotIds = [];
  const expiredSlotIdSet = new Set();

  for (const doc of plantSlots) {
    for (const subtypeSlot of doc.subtypeSlots || []) {
      const psKey = plantSubtypeKey(doc.plantId, subtypeSlot.subtypeId);
      if (!slotsByPlantSubtype.has(psKey)) {
        slotsByPlantSubtype.set(psKey, []);
      }
      const list = slotsByPlantSubtype.get(psKey);

      for (const slot of subtypeSlot.slots || []) {
        if (slot.status === false) continue;

        const slotId = slot._id?.toString?.() || String(slot._id);
        const startM = slotStartMoment(slot);

        const sourceDetails = {
          plantSlotId: doc._id,
          plantId: doc.plantId,
          plantSlotYear: doc.year,
          subtypeId: subtypeSlot.subtypeId,
          slot,
        };

        slotById.set(slotId, sourceDetails);
        list.push({
          slotId,
          startM,
          plantSlotId: doc._id,
          plantId: doc.plantId,
          plantSlotYear: doc.year,
          subtypeId: subtypeSlot.subtypeId,
          slot,
        });

        if (isSlotExpiredByEndDay(slot, asOfDate)) {
          const oid = slot._id;
          const idStr = oid?.toString?.() || String(oid);
          if (!expiredSlotIdSet.has(idStr)) {
            expiredSlotIdSet.add(idStr);
            expiredSlotIds.push(oid);
          }
        }
      }

      list.sort((a, b) => a.startM.valueOf() - b.startM.valueOf());
    }
  }

  return { slotById, slotsByPlantSubtype, expiredSlotIds };
}

function slotItemToTargetMeta(item, asOfDate = new Date()) {
  return {
    plantSlotId: item.plantSlotId,
    plantId: item.plantId,
    plantSlotYear: item.plantSlotYear,
    subtypeId: item.subtypeId,
    slot: item.slot,
    slotId: item.slotId,
    deliveryDate: deliveryDateForRolloverTarget(item.slot, asOfDate),
  };
}

/**
 * Single rollover destination per plant+subtype:
 * 1) slot containing today (e.g. 6 Jul after 10 Jun slot ended)
 * 2) else first upcoming active slot
 * 3) else latest active slot by start
 */
export function findRolloverTargetSlotForSubtype(
  slotsByPlantSubtype,
  plantId,
  subtypeId,
  asOfDate = new Date()
) {
  const list = slotsByPlantSubtype.get(plantSubtypeKey(plantId, subtypeId)) || [];
  if (!list.length) return null;

  const asOf = asOfStartOfDay(asOfDate);

  for (const item of list) {
    if (isSlotContainingDate(item.slot, asOfDate)) {
      return slotItemToTargetMeta(item, asOfDate);
    }
  }

  let nextUpcoming = null;
  let latestActive = null;
  for (const item of list) {
    if (!isSlotActive(item.slot, asOfDate)) continue;
    if (!latestActive || item.startM.isAfter(latestActive.startM)) {
      latestActive = item;
    }
    if (item.startM.isAfter(asOf, "day")) {
      if (!nextUpcoming || item.startM.isBefore(nextUpcoming.startM)) {
        nextUpcoming = item;
      }
    }
  }

  if (nextUpcoming) return slotItemToTargetMeta(nextUpcoming, asOfDate);
  return latestActive ? slotItemToTargetMeta(latestActive, asOfDate) : null;
}

export function buildRolloverTargetsByPlantSubtype(
  slotsByPlantSubtype,
  asOfDate = new Date()
) {
  const map = new Map();
  for (const psKey of slotsByPlantSubtype.keys()) {
    const sep = psKey.indexOf(":");
    const plantId = psKey.slice(0, sep);
    const subtypeId = psKey.slice(sep + 1);
    const target = findRolloverTargetSlotForSubtype(
      slotsByPlantSubtype,
      plantId,
      subtypeId,
      asOfDate
    );
    if (target) map.set(psKey, target);
  }
  return map;
}

/** @deprecated Use findRolloverTargetSlotForSubtype — per-expired-slot "next" caused split across windows. */
export function findNextSlotFromCache(
  slotsByPlantSubtype,
  plantId,
  subtypeId,
  _expiredSlot,
  asOfDate = new Date()
) {
  return findRolloverTargetSlotForSubtype(
    slotsByPlantSubtype,
    plantId,
    subtypeId,
    asOfDate
  );
}

/**
 * Skip only when already rolled onto this subtype's current target and that slot is still active.
 */
export function shouldSkipRolloverCached(
  order,
  asOfDate,
  slotById,
  rolloverTargetsByPsKey
) {
  if (!order.pastDueSlotRollover) return false;
  const bookingId =
    order.bookingSlot?.toString?.() || String(order.bookingSlot || "");
  const entry = slotById.get(bookingId);
  if (!entry?.slot) return false;

  const target = rolloverTargetsByPsKey?.get(
    plantSubtypeKey(entry.plantId, entry.subtypeId)
  );
  if (!target?.slotId || target.slotId !== bookingId) {
    return false;
  }
  return isSlotActive(entry.slot, asOfDate);
}

async function findSlotDetails(slotId) {
  if (!slotId || !mongoose.Types.ObjectId.isValid(String(slotId))) return null;
  const slotObjectId = new mongoose.Types.ObjectId(String(slotId));
  const plantSlotDoc = await PlantSlot.findOne({
    "subtypeSlots.slots._id": slotObjectId,
  }).lean();
  if (!plantSlotDoc) return null;

  for (const subtype of plantSlotDoc.subtypeSlots || []) {
    const slot = (subtype.slots || []).find(
      (item) => item._id?.toString() === slotObjectId.toString()
    );
    if (slot) {
      return {
        plantSlotId: plantSlotDoc._id,
        plantId: plantSlotDoc.plantId,
        plantSlotYear: plantSlotDoc.year,
        subtypeId: subtype.subtypeId,
        slot,
      };
    }
  }
  return null;
}

/** @deprecated Prefer findNextSlotFromCache after buildSlotRolloverIndexes. */
export async function findNextSlotAfterWindow(plantId, subtypeId, expiredSlot) {
  if (!plantId || !subtypeId || !expiredSlot?.endDay) return null;

  const anchor = moment(expiredSlot.endDay, "DD-MM-YYYY")
    .utcOffset(IST_OFFSET)
    .startOf("day");
  if (!anchor.isValid()) return null;

  const years = [anchor.year(), anchor.year() + 1];
  const plantSlots = await PlantSlot.find({
    plantId,
    year: { $in: years },
    "subtypeSlots.subtypeId": subtypeId,
  })
    .select(PLANT_SLOT_SELECT)
    .lean();

  const { slotsByPlantSubtype } = buildSlotRolloverIndexes(plantSlots, new Date());
  return findNextSlotFromCache(
    slotsByPlantSubtype,
    plantId,
    subtypeId,
    expiredSlot,
    new Date()
  );
}

async function shouldSkipRollover(order, asOfDate, slotById, rolloverTargetsByPsKey) {
  if (slotById) {
    return shouldSkipRolloverCached(
      order,
      asOfDate,
      slotById,
      rolloverTargetsByPsKey || new Map()
    );
  }
  if (!order.pastDueSlotRollover) return false;
  const window = await getSlotWindowById(order.bookingSlot);
  if (!window) return false;
  const asOf = asOfStartOfDay(asOfDate).toDate();
  return !isDateOutsideSlotWindow(asOf, window);
}

export async function rolloverOneOrder(order, sourceDetails, targetMeta, session) {
  const sourceSlotId = order.bookingSlot;
  const targetSlotId = targetMeta.slotId;
  const orderPlants = orderPlantCount(order);
  if (orderPlants <= 0) {
    throw new Error(`Order ${order._id} has zero plants`);
  }

  const targetDetails = {
    plantSlotId: targetMeta.plantSlotId,
    plantId: targetMeta.plantId,
    plantSlotYear: targetMeta.plantSlotYear,
    subtypeId: targetMeta.subtypeId,
    slot: targetMeta.slot,
  };

  const preservedOldDelivery = order.dispatchedFromAnotherSlot
    ? order.oldDeliveryDate
    : order.deliveryDate || null;
  const preservedOriginalSlot = order.dispatchedFromAnotherSlot
    ? order.originalBookingSlot || order.bookingSlot
    : order.bookingSlot;

  const now = new Date();
  const newDeliveryDate =
    targetMeta.deliveryDate ||
    deliveryDateForRolloverTarget(targetDetails.slot, now);
  const isReadyPlantsOrder = !!(order.productMappingId && order.productName);

  const sourceSlotObjectId = new mongoose.Types.ObjectId(String(sourceSlotId));
  const targetSlotObjectId = new mongoose.Types.ObjectId(String(targetSlotId));

  await moveOrderBetweenSlots({
    orderId: order._id,
    fromSlotId: sourceSlotId,
    toSlotId: targetSlotId,
    plantsCount: orderPlants,
    session,
    isReadyPlantsOrder,
  });

  await appendSlotTrail({
    slotId: sourceSlotId,
    action: SLOT_TRAIL_ACTIONS.PAST_DUE_ROLLOUT_OUT,
    quantity: orderPlants,
    orderId: order._id,
    performedBy: null,
    notes: `Past-due rollover to ${targetDetails.slot.startDay}–${targetDetails.slot.endDay}`,
    session,
  });
  await appendSlotTrail({
    slotId: targetSlotId,
    action: SLOT_TRAIL_ACTIONS.PAST_DUE_ROLLOUT_IN,
    quantity: orderPlants,
    orderId: order._id,
    performedBy: null,
    notes: `Past-due rollover from ${sourceDetails.slot.startDay}–${sourceDetails.slot.endDay}`,
    session,
  });

  const deliveryChangeEntry = {
    previousDeliveryDate: {
      startDay: sourceDetails.slot.startDay,
      endDay: sourceDetails.slot.endDay,
      month: sourceDetails.slot.month,
      year: sourceDetails.plantSlotYear,
    },
    newDeliveryDate: {
      startDay: targetDetails.slot.startDay,
      endDay: targetDetails.slot.endDay,
      month: targetDetails.slot.month,
      year: targetDetails.plantSlotYear,
    },
    previousSlot: sourceSlotObjectId,
    newSlot: targetSlotObjectId,
    reasonForChange: "Past due slot rollover",
    changedBy: null,
  };

  const previousDelivery = order.deliveryDate ? new Date(order.deliveryDate) : null;

  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        bookingSlot: targetSlotObjectId,
        deliveryDate: newDeliveryDate,
        dispatchedFromAnotherSlot: true,
        pastDueSlotRollover: true,
        pastDueSlotRolloverAt: now,
        oldDeliveryDate: preservedOldDelivery,
        originalBookingSlot: preservedOriginalSlot,
      },
      $push: {
        deliveryChanges: deliveryChangeEntry,
        orderEditHistory: {
          field: "bookingSlot+deliveryDate",
          previousValue: {
            bookingSlot: sourceSlotObjectId,
            deliveryDate: previousDelivery,
          },
          newValue: {
            bookingSlot: targetSlotObjectId,
            deliveryDate: newDeliveryDate,
          },
          changedBy: null,
          notes: `Past-due slot rollover: ${sourceDetails.slot.startDay}–${sourceDetails.slot.endDay} → ${targetDetails.slot.startDay}–${targetDetails.slot.endDay}`,
        },
      },
    },
    { session }
  );

  return {
    deliveryChange: deliveryChangeEntry,
    occurredAt: now,
    slotLabel: `Past-due slot rollover: ${sourceDetails.slot.startDay}–${sourceDetails.slot.endDay} → ${targetDetails.slot.startDay}–${targetDetails.slot.endDay}`,
  };
}

/**
 * Plan rollover without writes — status/state breakdown + orders to move list.
 * @param {{ asOfDate?: Date|string, onProgress?: (msg: string) => void }} options
 */
function matchesPlantSubtypeFilter(sourceDetails, plantId, subtypeId) {
  if (!sourceDetails) return false;
  if (plantId) {
    const pid = sourceDetails.plantId?.toString?.() || String(sourceDetails.plantId || "");
    if (pid !== String(plantId)) return false;
  }
  if (subtypeId) {
    const sid =
      sourceDetails.subtypeId?.toString?.() || String(sourceDetails.subtypeId || "");
    if (sid !== String(subtypeId)) return false;
  }
  return true;
}

/**
 * @param {{ asOfDate?: Date|string, onProgress?: (msg: string) => void, plantId?: string, subtypeId?: string }} options
 */
export async function planPastDueSlotRollover({ asOfDate, onProgress, plantId, subtypeId } = {}) {
  const log = (msg) => {
    if (onProgress) onProgress(msg);
    else console.log(msg);
  };

  const asOf = asOfDate ? new Date(asOfDate) : new Date();
  const byOrderStatus = {};
  const ordersToMove = [];
  const skippedReasons = {
    alreadyRolled: 0,
    noSourceSlot: 0,
    noNextSlot: 0,
  };

  const summary = {
    asOf: asOfStartOfDay(asOf).format("YYYY-MM-DD"),
    slotsScanned: 0,
    ordersLoaded: 0,
    ordersToMove: 0,
    ordersSkipped: 0,
    plantsToMove: 0,
    skippedReasons,
    errors: [],
    ordersToMoveList: ordersToMove,
    allOrdersOnExpiredSlots: 0,
    breakdown: {
      allOnExpiredByStatus: [],
      toMoveByStatus: [],
      totals: { orders: 0, plants: 0 },
    },
  };

  const t0 = Date.now();
  const plantSlotQuery = {};
  if (plantId && mongoose.isValidObjectId(String(plantId))) {
    plantSlotQuery.plantId = new mongoose.Types.ObjectId(String(plantId));
  }
  if (subtypeId && mongoose.isValidObjectId(String(subtypeId))) {
    plantSlotQuery["subtypeSlots.subtypeId"] = new mongoose.Types.ObjectId(
      String(subtypeId)
    );
  }
  const scoped =
    Object.keys(plantSlotQuery).length > 0
      ? ` (plant=${plantId || "—"} subtype=${subtypeId || "—"})`
      : "";
  log(`[past-due-rollover] loading plant slots (single query)${scoped}...`);
  const plantSlots = await PlantSlot.find(plantSlotQuery)
    .select(PLANT_SLOT_SELECT)
    .lean();
  log(
    `[past-due-rollover] plant slot docs loaded: ${plantSlots.length} (${Date.now() - t0}ms)`
  );

  const { slotById, slotsByPlantSubtype, expiredSlotIds } = buildSlotRolloverIndexes(
    plantSlots,
    asOf
  );
  summary.slotsScanned = expiredSlotIds.length;
  log(`[past-due-rollover] expired booking slots: ${expiredSlotIds.length}`);

  const t1 = Date.now();
  log("[past-due-rollover] counting all orders on expired slots...");
  const allOnExpiredAgg =
    expiredSlotIds.length > 0
      ? await Order.aggregate([
    { $match: { bookingSlot: { $in: expiredSlotIds } } },
    {
      $addFields: {
        linePlantTotal: {
          $add: [
            { $ifNull: ["$numberOfPlants", 0] },
            { $ifNull: ["$additionalPlants", 0] },
          ],
        },
      },
    },
    {
      $group: {
        _id: "$orderStatus",
        orders: { $sum: 1 },
        plants: { $sum: "$linePlantTotal" },
      },
    },
  ])
      : [];
  const allOnExpiredByStatus = {};
  let allOrdersOnExpiredSlots = 0;
  for (const row of allOnExpiredAgg) {
    const status = row._id || "Unknown";
    allOnExpiredByStatus[status] = { orders: row.orders, plants: row.plants };
    allOrdersOnExpiredSlots += row.orders;
  }
  summary.allOrdersOnExpiredSlots = allOrdersOnExpiredSlots;
  log(
    `[past-due-rollover] all orders on expired slots: ${allOrdersOnExpiredSlots} (${Date.now() - t1}ms)`
  );

  const rolloverTargetsByPsKey = buildRolloverTargetsByPlantSubtype(
    slotsByPlantSubtype,
    asOf
  );

  const eligiblePipelineMatch = {
    orderStatus: { $in: OPEN_PIPELINE_STATUSES },
    $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }],
  };

  const t2 = Date.now();
  log("[past-due-rollover] loading eligible orders...");
  const [ordersOnExpired, ordersMisplacedRoll] = await Promise.all([
    expiredSlotIds.length
      ? Order.find({
          ...eligiblePipelineMatch,
          bookingSlot: { $in: expiredSlotIds },
        })
          .select(ORDER_SELECT)
          .lean()
      : [],
    Order.find({
      ...eligiblePipelineMatch,
      pastDueSlotRollover: true,
      ...(expiredSlotIds.length
        ? { bookingSlot: { $nin: expiredSlotIds } }
        : {}),
    })
      .select(ORDER_SELECT)
      .lean(),
  ]);

  const orderById = new Map();
  for (const o of ordersOnExpired) orderById.set(String(o._id), o);
  for (const o of ordersMisplacedRoll) orderById.set(String(o._id), o);
  const orders = [...orderById.values()];

  summary.ordersLoaded = orders.length;
  log(
    `[past-due-rollover] eligible orders: ${orders.length} (expired=${ordersOnExpired.length} misplacedRoll=${ordersMisplacedRoll.length}) (${Date.now() - t2}ms)`
  );

  for (const order of orders) {
    const plants = orderPlantCount(order);
    const bookingKey =
      order.bookingSlot?.toString?.() || String(order.bookingSlot || "");
    const sourceDetails = slotById.get(bookingKey);

    if (!sourceDetails) {
      summary.ordersSkipped += 1;
      skippedReasons.noSourceSlot += 1;
      continue;
    }

    if (!matchesPlantSubtypeFilter(sourceDetails, plantId, subtypeId)) {
      continue;
    }

    const targetMeta = rolloverTargetsByPsKey.get(
      plantSubtypeKey(sourceDetails.plantId, sourceDetails.subtypeId)
    );

    const onTargetSlot = targetMeta && bookingKey === targetMeta.slotId;
    if (onTargetSlot && isSlotActive(sourceDetails.slot, asOf)) {
      summary.ordersSkipped += 1;
      skippedReasons.alreadyRolled += 1;
      continue;
    }

    if (!targetMeta) {
      summary.ordersSkipped += 1;
      skippedReasons.noNextSlot += 1;
      summary.errors.push({
        orderId: String(order._id),
        publicOrderId: order.orderId,
        orderStatus: order.orderStatus,
        plants,
        reason: "NO_NEXT_SLOT",
        expiredSlot: `${sourceDetails.slot.startDay}–${sourceDetails.slot.endDay}`,
      });
      continue;
    }

    const status = order.orderStatus || "Unknown";
    bumpBucket(byOrderStatus, status, plants);

    ordersToMove.push({
      orderId: String(order._id),
      publicOrderId: order.orderId,
      orderStatus: status,
      plants,
      fromSlot: `${sourceDetails.slot.startDay}–${sourceDetails.slot.endDay}`,
      toSlot: `${targetMeta.slot.startDay}–${targetMeta.slot.endDay}`,
      deliveryDate: targetMeta.deliveryDate,
    });

    summary.ordersToMove += 1;
    summary.plantsToMove += plants;
  }

  summary.breakdown = {
    allOnExpiredByStatus: finalizeBreakdown(allOnExpiredByStatus).byOrderStatus,
    toMoveByStatus: finalizeBreakdown(byOrderStatus).byOrderStatus,
    totals: finalizeBreakdown(byOrderStatus).totals,
  };
  log(
    `[past-due-rollover] plan complete: allOnExpired=${summary.allOrdersOnExpiredSlots} eligible=${summary.ordersLoaded} toMove=${summary.ordersToMove} skipped=${summary.ordersSkipped}`
  );
  return summary;
}

/**
 * @param {{ asOfDate?: Date|string, dryRun?: boolean, onProgress?: (msg: string) => void, plantId?: string, subtypeId?: string }} options
 */
export async function runPastDueSlotRollover({
  asOfDate,
  dryRun = false,
  onProgress,
  plantId,
  subtypeId,
} = {}) {
  const log = (msg) => {
    if (onProgress) onProgress(msg);
    else console.log(msg);
  };

  const asOf = asOfDate ? new Date(asOfDate) : new Date();
  const plan = await planPastDueSlotRollover({
    asOfDate: asOf,
    onProgress,
    plantId,
    subtypeId,
  });
  const summary = {
    asOf: plan.asOf,
    dryRun: Boolean(dryRun),
    slotsScanned: plan.slotsScanned,
    ordersLoaded: plan.ordersLoaded,
    ordersMoved: 0,
    ordersSkipped: plan.ordersSkipped,
    plantsToMove: plan.plantsToMove,
    skippedReasons: plan.skippedReasons,
    breakdown: plan.breakdown,
    ordersToMoveList: plan.ordersToMoveList,
    errors: [...plan.errors],
  };

  if (!plan.ordersToMove) {
    log("[past-due-rollover] nothing to move");
    return summary;
  }

  if (dryRun) {
    summary.ordersMoved = plan.ordersToMove;
    log(
      `[past-due-rollover] dry-run complete: would move=${summary.ordersMoved} skipped=${summary.ordersSkipped}`
    );
    return summary;
  }

  const t0 = Date.now();
  const orderIds = plan.ordersToMoveList.map((r) => r.orderId);
  const orders = await Order.find({ _id: { $in: orderIds } })
    .select(ORDER_SELECT)
    .lean();
  const orderById = new Map(orders.map((o) => [String(o._id), o]));

  const plantSlotQuery = {};
  if (plantId && mongoose.isValidObjectId(String(plantId))) {
    plantSlotQuery.plantId = new mongoose.Types.ObjectId(String(plantId));
  }
  if (subtypeId && mongoose.isValidObjectId(String(subtypeId))) {
    plantSlotQuery["subtypeSlots.subtypeId"] = new mongoose.Types.ObjectId(
      String(subtypeId)
    );
  }
  const plantSlots = await PlantSlot.find(plantSlotQuery)
    .select(PLANT_SLOT_SELECT)
    .lean();
  const { slotById, slotsByPlantSubtype } = buildSlotRolloverIndexes(plantSlots, asOf);
  const rolloverTargetsByPsKey = buildRolloverTargetsByPlantSubtype(
    slotsByPlantSubtype,
    asOf
  );

  for (const row of plan.ordersToMoveList) {
    const order = orderById.get(row.orderId);
    if (!order) continue;
    try {
      const bookingKey =
        order.bookingSlot?.toString?.() || String(order.bookingSlot || "");
      const sourceDetails = slotById.get(bookingKey);
      const targetMeta = sourceDetails
        ? rolloverTargetsByPsKey.get(
            plantSubtypeKey(sourceDetails.plantId, sourceDetails.subtypeId)
          )
        : null;
      if (!sourceDetails || !targetMeta) {
        summary.ordersSkipped += 1;
        continue;
      }

      const session = await mongoose.startSession();
      try {
        let timelinePayload;
        await session.withTransaction(async () => {
          timelinePayload = await rolloverOneOrder(
            order,
            sourceDetails,
            targetMeta,
            session
          );
        });
        summary.ordersMoved += 1;
        if (timelinePayload) {
          await emitPastDueRolloverTimelineEvents(order._id, timelinePayload).catch(
            (e) =>
              console.error(
                "[past-due-rollover] OrderEvent emit failed:",
                order._id,
                e?.message || e
              )
          );
        }
      } finally {
        await session.endSession();
      }
    } catch (err) {
      summary.ordersSkipped += 1;
      summary.errors.push({
        orderId: row.orderId,
        publicOrderId: row.publicOrderId,
        reason: err?.message || String(err),
      });
      console.error("[past-due-rollover] order failed:", row.orderId, err?.message || err);
    }
  }

  log(
    `[past-due-rollover] run complete in ${Date.now() - t0}ms: moved=${summary.ordersMoved} skipped=${summary.ordersSkipped}`
  );
  return summary;
}
