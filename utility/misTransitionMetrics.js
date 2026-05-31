import {
  orderEventTypesForTransition,
  orderEventStatusValueMatch,
  transitionHasOrderEventLookupStages,
} from "./misTransitionFromEvents.js";
import { ORDER_DOMAINS } from "../modules/orderEvents/domain/constants.js";

const IST = "Asia/Kolkata";

/** When statusChanges lacks an entry, infer transition from current status + updatedAt. */
export const LEGACY_ORDER_STATUS_FOR_TRANSITION = {
  /** Out only — COMPLETED / PARTIAL belong in Done / Partial columns, not Out. */
  DISPATCHED: ["DISPATCHED"],
  COMPLETED: ["COMPLETED"],
};

function legacyStatusesFor(newStatus) {
  return LEGACY_ORDER_STATUS_FOR_TRANSITION[newStatus] || [newStatus];
}

/** Some legacy rows store a single object instead of an array. */
export function normalizeStatusChangesExpr() {
  return {
    $cond: [
      { $isArray: "$statusChanges" },
      { $ifNull: ["$statusChanges", []] },
      {
        $cond: [
          {
            $and: [
              { $ne: ["$statusChanges", null] },
              { $ne: [{ $type: "$statusChanges" }, "missing"] },
            ],
          },
          ["$statusChanges"],
          [],
        ],
      },
    ],
  };
}

export function misTransitionEverScField(newStatus) {
  return {
    _misEverSc: {
      $gt: [
        {
          $size: {
            $filter: {
              input: normalizeStatusChangesExpr(),
              as: "sc",
              cond: { $eq: ["$$sc.newStatus", newStatus] },
            },
          },
        },
        0,
      ],
    },
  };
}

export function istDayFromEventField(eventField = "$_misEventAt") {
  return {
    $dateToString: {
      format: "%Y-%m-%d",
      date: eventField,
      timezone: IST,
    },
  };
}

/** Unwind statusChanges — one row per transition event in range (for daily Out/Done cells). */
export function transitionHistoryByDayStages(newStatus, rangeStart, rangeEnd, preStages = []) {
  return [
    ...preStages,
    ...transitionHasOrderEventLookupStages(newStatus, rangeStart, rangeEnd),
    { $match: { _misHasOrdEv: false } },
    { $addFields: { _misSc: normalizeStatusChangesExpr() } },
    { $unwind: "$_misSc" },
    {
      $addFields: {
        _misEventAt: { $ifNull: ["$_misSc.createdAt", "$_misSc.changedAt"] },
      },
    },
    {
      $match: {
        "_misSc.newStatus": newStatus,
        _misEventAt: { $gte: rangeStart, $lte: rangeEnd },
      },
    },
    {
      $group: {
        _id: {
          day: istDayFromEventField(),
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
  ];
}

/** One row per IST day + order (before daily rollup). */
export function transitionHistoryByDayPerOrderStages(
  newStatus,
  rangeStart,
  rangeEnd,
  preStages = []
) {
  return transitionHistoryByDayStages(newStatus, rangeStart, rangeEnd, preStages).slice(0, -1);
}

/** One row per entity + order in range (before entity rollup). */
export function transitionHistoryByEntityPerOrderStages(
  newStatus,
  rangeStart,
  rangeEnd,
  groupIdFields,
  preStages = []
) {
  return transitionHistoryByEntityStages(
    newStatus,
    rangeStart,
    rangeEnd,
    groupIdFields,
    preStages
  ).slice(0, -1);
}

/** Second entity $group must read keys from prior _id, not re-run lookup expressions. */
export function entityRollupGroupId(groupIdFields) {
  const id = {};
  for (const key of Object.keys(groupIdFields)) {
    id[key] = `$_id.${key}`;
  }
  return id;
}

/** After unwind — group by entity + order (sales / variety breakdown). */
export function transitionHistoryByEntityStages(
  newStatus,
  rangeStart,
  rangeEnd,
  groupIdFields,
  preStages = []
) {
  return [
    ...transitionHistoryByDayStages(newStatus, rangeStart, rangeEnd, preStages).slice(0, -2),
    {
      $group: {
        _id: { ...groupIdFields, orderId: "$_id" },
        plants: { $first: "$linePlantTotal" },
      },
    },
    {
      $group: {
        _id: entityRollupGroupId(groupIdFields),
        orders: { $sum: 1 },
        plants: { $sum: "$plants" },
      },
    },
  ];
}

export function transitionLegacyByEntityStages(
  newStatus,
  rangeStart,
  rangeEnd,
  groupIdFields,
  preStages = []
) {
  const legacyStatuses = legacyStatusesFor(newStatus);
  return [
    ...preStages,
    ...transitionHasOrderEventLookupStages(newStatus, rangeStart, rangeEnd),
    { $match: { _misHasOrdEv: false } },
    { $addFields: misTransitionEverScField(newStatus) },
    {
      $match: {
        _misEverSc: false,
        orderStatus: { $in: legacyStatuses },
        updatedAt: { $gte: rangeStart, $lte: rangeEnd },
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
        _id: entityRollupGroupId(groupIdFields),
        orders: { $sum: 1 },
        plants: { $sum: "$plants" },
      },
    },
  ];
}

/** Legacy rows without statusChanges history — one event per order on updatedAt day. */
export function transitionLegacyByDayStages(newStatus, rangeStart, rangeEnd, preStages = []) {
  const legacyStatuses = legacyStatusesFor(newStatus);
  return [
    ...preStages,
    ...transitionHasOrderEventLookupStages(newStatus, rangeStart, rangeEnd),
    { $match: { _misHasOrdEv: false } },
    { $addFields: misTransitionEverScField(newStatus) },
    {
      $match: {
        _misEverSc: false,
        orderStatus: { $in: legacyStatuses },
        updatedAt: { $gte: rangeStart, $lte: rangeEnd },
      },
    },
    { $addFields: { _misEventAt: "$updatedAt" } },
    {
      $group: {
        _id: {
          day: istDayFromEventField(),
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
  ];
}

/** One row per IST day + order (legacy fallback). */
export function transitionLegacyByDayPerOrderStages(
  newStatus,
  rangeStart,
  rangeEnd,
  preStages = []
) {
  return transitionLegacyByDayStages(newStatus, rangeStart, rangeEnd, preStages).slice(0, -1);
}

/** One row per entity + order (legacy fallback). */
export function transitionLegacyByEntityPerOrderStages(
  newStatus,
  rangeStart,
  rangeEnd,
  groupIdFields,
  preStages = []
) {
  return transitionLegacyByEntityStages(
    newStatus,
    rangeStart,
    rangeEnd,
    groupIdFields,
    preStages
  ).slice(0, -1);
}

/** Drawer: unique orders — OrderEvent first, then statusChanges, then legacy. */
export function transitionDrawerFacetStages(newStatus, rangeStart, rangeEnd) {
  const legacyStatuses = legacyStatusesFor(newStatus);
  const eventTypes = orderEventTypesForTransition(newStatus);
  const eventValueMatch = orderEventStatusValueMatch(newStatus);
  return [
    {
      $facet: {
        events: [
          {
            $lookup: {
              from: "orderevents",
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
                { $match: eventValueMatch },
              ],
              as: "_misEv",
            },
          },
          { $unwind: "$_misEv" },
          {
            $group: {
              _id: "$_id",
              bucketEventAt: { $min: "$_misEv.occurredAt" },
            },
          },
        ],
        history: [
          ...transitionHasOrderEventLookupStages(newStatus, rangeStart, rangeEnd),
          { $match: { _misHasOrdEv: false } },
          { $addFields: { _misSc: normalizeStatusChangesExpr() } },
          { $unwind: "$_misSc" },
          {
            $addFields: {
              _misEventAt: { $ifNull: ["$_misSc.createdAt", "$_misSc.changedAt"] },
            },
          },
          {
            $match: {
              "_misSc.newStatus": newStatus,
              _misEventAt: { $gte: rangeStart, $lte: rangeEnd },
            },
          },
          {
            $group: {
              _id: "$_id",
              bucketEventAt: { $min: "$_misEventAt" },
            },
          },
        ],
        legacy: [
          ...transitionHasOrderEventLookupStages(newStatus, rangeStart, rangeEnd),
          { $match: { _misHasOrdEv: false } },
          { $addFields: misTransitionEverScField(newStatus) },
          {
            $match: {
              _misEverSc: false,
              orderStatus: { $in: legacyStatuses },
              updatedAt: { $gte: rangeStart, $lte: rangeEnd },
            },
          },
          {
            $group: {
              _id: "$_id",
              bucketEventAt: { $first: "$updatedAt" },
            },
          },
        ],
      },
    },
    {
      $project: {
        combined: { $concatArrays: ["$events", "$history", "$legacy"] },
      },
    },
    { $unwind: "$combined" },
    {
      $group: {
        _id: "$combined._id",
        bucketEventAt: { $min: "$combined.bucketEventAt" },
      },
    },
  ];
}

/** @deprecated use transitionHistoryByDayStages — kept for tests inspecting field shape */
export function misTransitionEventAtAddFields(newStatus, rangeStart, rangeEnd) {
  return misTransitionEverScField(newStatus);
}

/** @deprecated use transitionDrawerFacetStages */
export function misTransitionEventAtStages(newStatus, rangeStart, rangeEnd) {
  return transitionDrawerFacetStages(newStatus, rangeStart, rangeEnd);
}
