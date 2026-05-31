import OrderEvent from "../modules/orderEvents/models/orderEvent.model.js";
import {
  ORDER_DOMAINS,
  ORDER_EVENT_TYPES,
} from "../modules/orderEvents/domain/constants.js";
import { LINE_PLANT_TOTAL_ADD_FIELDS } from "./istOrderDateStats.js";
const IST = "Asia/Kolkata";

function istDayFromOccurredAt() {
  return {
    $dateToString: {
      format: "%Y-%m-%d",
      date: "$occurredAt",
      timezone: IST,
    },
  };
}

function entityRollupFrom(groupIdFields) {
  const id = {};
  for (const key of Object.keys(groupIdFields)) {
    id[key] = `$_id.${key}`;
  }
  return id;
}

/** Central resolution order for Out/Done (see metricRules status_transition). */
export const MIS_TRANSITION_RESOLUTION_ORDER = [
  "order_event",
  "status_changes",
  "legacy_updated_at",
];

const TYPED_EVENTS_BY_STATUS = {
  DISPATCHED: [ORDER_EVENT_TYPES.ORDER_DISPATCHED],
  COMPLETED: [ORDER_EVENT_TYPES.ORDER_COMPLETED, ORDER_EVENT_TYPES.ORDER_DELIVERED],
};

export function orderEventTypesForTransition(newStatus) {
  const status = String(newStatus).toUpperCase();
  return [
    ORDER_EVENT_TYPES.ORDER_STATUS_CHANGED,
    ...(TYPED_EVENTS_BY_STATUS[status] || []),
  ];
}

/** $match body: ORDER_STATUS_CHANGED must match newValue; typed events pass through. */
export function orderEventStatusValueMatch(newStatus) {
  const status = String(newStatus).toUpperCase();
  return {
    $or: [
      { eventType: { $ne: ORDER_EVENT_TYPES.ORDER_STATUS_CHANGED } },
      {
        $expr: {
          $eq: [
            {
              $toUpper: {
                $trim: {
                  input: { $ifNull: [{ $toString: "$newValue" }, ""] },
                },
              },
            },
            status,
          ],
        },
      },
    ],
  };
}

function baseEventMatch(newStatus, rangeStart, rangeEnd) {
  return {
    orderDomain: ORDER_DOMAINS.PLANT,
    eventType: { $in: orderEventTypesForTransition(newStatus) },
    occurredAt: { $gte: rangeStart, $lte: rangeEnd },
    ...orderEventStatusValueMatch(newStatus),
  };
}

/** Order ids that already have a transition event in range — skip statusChanges + legacy. */
export async function distinctOrderIdsWithTransitionEvents(
  newStatus,
  rangeStart,
  rangeEnd
) {
  const rows = await OrderEvent.aggregate([
    { $match: baseEventMatch(newStatus, rangeStart, rangeEnd) },
    { $group: { _id: "$orderId" } },
  ]);
  return rows.map((r) => r._id).filter(Boolean);
}

export function transitionExcludeOrderIdsMatch(excludeOrderIds) {
  if (!excludeOrderIds?.length) return {};
  return { _id: { $nin: excludeOrderIds } };
}

/** Lookup stages: true when this order has any matching transition event in range. */
export function transitionHasOrderEventLookupStages(newStatus, rangeStart, rangeEnd) {
  const eventTypes = orderEventTypesForTransition(newStatus);
  return [
    {
      $lookup: {
        from: OrderEvent.collection.name,
        let: { oid: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$orderId", "$$oid"] },
              orderDomain: ORDER_DOMAINS.PLANT,
              eventType: { $in: eventTypes },
              occurredAt: { $gte: rangeStart, $lte: rangeEnd },
            },
          },
          { $match: orderEventStatusValueMatch(newStatus) },
          { $limit: 1 },
        ],
        as: "_misOrdEv",
      },
    },
    {
      $addFields: {
        _misHasOrdEv: { $gt: [{ $size: { $ifNull: ["$_misOrdEv", []] } }, 0] },
      },
    },
  ];
}

/** Per event row after order lookup — group by IST day (daily Out/Done). */
export function transitionEventsByDayStages(
  newStatus,
  rangeStart,
  rangeEnd,
  statusMatch,
  preStages = []
) {
  return [
    { $match: baseEventMatch(newStatus, rangeStart, rangeEnd) },
    {
      $lookup: {
        from: "orders",
        localField: "orderId",
        foreignField: "_id",
        as: "_order",
        pipeline: [
          { $match: statusMatch },
          { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
          ...(preStages.length ? preStages : [{ $project: { linePlantTotal: 1 } }]),
        ],
      },
    },
    { $unwind: "$_order" },
    {
      $group: {
        _id: {
          day: istDayFromOccurredAt(),
          orderId: "$orderId",
        },
        plants: { $first: "$_order.linePlantTotal" },
      },
    },
    {
      $group: {
        _id: "$_id.day",
        orders: { $sum: 1 },
        plants: { $sum: "$plants" },
      },
    },
  ];
}

/** One row per IST day + order (OrderEvent path). */
export function transitionEventsByDayPerOrderStages(
  newStatus,
  rangeStart,
  rangeEnd,
  statusMatch,
  preStages = []
) {
  return transitionEventsByDayStages(newStatus, rangeStart, rangeEnd, statusMatch, preStages).slice(
    0,
    -1
  );
}

/** One row per entity + order (OrderEvent path). */
export function transitionEventsByEntityPerOrderStages(
  newStatus,
  rangeStart,
  rangeEnd,
  statusMatch,
  groupIdFields,
  groupStages
) {
  return transitionEventsByEntityStages(
    newStatus,
    rangeStart,
    rangeEnd,
    statusMatch,
    groupIdFields,
    groupStages
  ).slice(0, -1);
}

/** Per event row — group by entity + order (variety / sales / dealer). */
export function transitionEventsByEntityStages(
  newStatus,
  rangeStart,
  rangeEnd,
  statusMatch,
  groupIdFields,
  groupStages
) {
  return [
    { $match: baseEventMatch(newStatus, rangeStart, rangeEnd) },
    {
      $lookup: {
        from: "orders",
        localField: "orderId",
        foreignField: "_id",
        as: "_order",
        pipeline: [
          { $match: statusMatch },
          { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
          ...groupStages,
        ],
      },
    },
    { $unwind: "$_order" },
    { $replaceRoot: { newRoot: { $mergeObjects: ["$_order", { _misEventAt: "$occurredAt" }] } } },
    {
      $group: {
        _id: { ...groupIdFields, orderId: "$_id" },
        plants: { $first: "$linePlantTotal" },
      },
    },
    {
      $group: {
        _id: entityRollupFrom(groupIdFields),
        orders: { $sum: 1 },
        plants: { $sum: "$plants" },
      },
    },
  ];
}

export async function aggregateTransitionEventsByDay(
  newStatus,
  rangeStart,
  rangeEnd,
  statusMatch,
  preStages = []
) {
  return OrderEvent.aggregate(
    transitionEventsByDayStages(newStatus, rangeStart, rangeEnd, statusMatch, preStages)
  );
}

export async function aggregateTransitionEventsByGroup(
  newStatus,
  rangeStart,
  rangeEnd,
  statusMatch,
  groupStages,
  groupIdFields
) {
  return OrderEvent.aggregate(
    transitionEventsByEntityStages(
      newStatus,
      rangeStart,
      rangeEnd,
      statusMatch,
      groupIdFields,
      groupStages
    )
  );
}
