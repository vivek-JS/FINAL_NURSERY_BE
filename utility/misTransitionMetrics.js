const IST = "Asia/Kolkata";

/** When statusChanges lacks an entry, infer transition from current status + updatedAt. */
export const LEGACY_ORDER_STATUS_FOR_TRANSITION = {
  DISPATCHED: ["DISPATCHED", "COMPLETED", "PARTIALLY_COMPLETED"],
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
        _id: groupIdFields,
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
        _id: groupIdFields,
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

/** Drawer: unique orders with any transition in window (history + legacy). */
export function transitionDrawerFacetStages(newStatus, rangeStart, rangeEnd) {
  const legacyStatuses = legacyStatusesFor(newStatus);
  return [
    {
      $facet: {
        history: [
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
        combined: { $concatArrays: ["$history", "$legacy"] },
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
