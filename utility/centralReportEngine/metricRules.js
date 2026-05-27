/**
 * Single source of truth for Admin MIS / central report column semantics.
 * Used by aggregations (adminMisMetrics), drawer filters (FE), and report registry docs.
 */

export const MIS_TIMEZONE = "Asia/Kolkata";

/** @typedef {'date_field'|'status_and_date'|'global_status'|'status_transition'|'delivery_union'|'pipeline_by_delivery'|'computed'} MetricKind */

/**
 * @type {Record<string, { kind: MetricKind, label: string, description: string, [key: string]: unknown }>}
 */
export const MIS_DELIVERY_METRICS = {
  booked: {
    kind: "date_field",
    label: "Booked",
    dateField: "orderBookingDate",
    description: "Orders whose booking date falls in the selected IST range.",
  },
  deliveryTotal: {
    kind: "delivery_union",
    label: "Delivery total",
    description:
      "Daily/sales footer: delivery in range (excl. DISPATCHED) OR current FARM_READY OR RFD. Variety row: delivery in range only (excl. DISPATCHED). Out column is separate.",
  },
  accepted: {
    kind: "status_and_date",
    label: "Accepted",
    status: "ACCEPTED",
    dateField: "deliveryDate",
    description: "Delivery date in range and orderStatus ACCEPTED.",
  },
  farmReady: {
    kind: "global_status",
    label: "Farm ready",
    status: "FARM_READY",
    description: "All orders currently FARM_READY (no delivery-date filter). Same count on each daily row.",
  },
  readyForDispatch: {
    kind: "global_status",
    label: "Ready for dispatch",
    status: "READY_FOR_DISPATCH",
    description: "All orders currently READY_FOR_DISPATCH (no delivery-date filter).",
  },
  dispatchProcess: {
    kind: "pipeline_by_delivery",
    label: "In dispatch",
    status: "DISPATCH_PROCESS",
    dateField: "deliveryDate",
    description: "Current DISPATCH_PROCESS with delivery date in range.",
  },
  partiallyCompleted: {
    kind: "pipeline_by_delivery",
    label: "Partial",
    status: "PARTIALLY_COMPLETED",
    dateField: "deliveryDate",
    description: "Current PARTIALLY_COMPLETED with delivery date in range.",
  },
  dispatched: {
    kind: "status_transition",
    label: "Out / Dispatched",
    transitionStatus: "DISPATCHED",
    description: "statusChanges.newStatus = DISPATCHED on the event day (IST), not delivery date.",
  },
  completed: {
    kind: "status_transition",
    label: "Completed",
    transitionStatus: "COMPLETED",
    description: "statusChanges.newStatus = COMPLETED on the event day (IST).",
  },
  other: {
    kind: "pipeline_by_delivery",
    label: "Other",
    statuses: ["PENDING", "PROCESSING", "ASSIGNED"],
    dateField: "deliveryDate",
    description: "Pre-dispatch pipeline statuses with delivery in range (excluding buckets above).",
  },
  yetToDispatch: {
    kind: "computed",
    label: "Yet to dispatch",
    sumOf: [
      "accepted",
      "farmReady",
      "readyForDispatch",
      "dispatchProcess",
      "partiallyCompleted",
      "other",
    ],
    description: "Frontend sum of pre-dispatch buckets (excludes Out and Completed).",
  },
};

export const MIS_DELIVERY_METRIC_KEYS = Object.keys(MIS_DELIVERY_METRICS);

/** Drawer bucket key → metric rule key */
export const DRAWER_BUCKET_TO_METRIC = {
  booking: "booked",
  deliveryTotal: "deliveryTotal",
  accepted: "accepted",
  farmReady: "farmReady",
  readyForDispatch: "readyForDispatch",
  dispatchProcess: "dispatchProcess",
  partiallyCompleted: "partiallyCompleted",
  dispatched: "dispatched",
  completed: "completed",
  other: "other",
  yetToDispatch: "yetToDispatch",
};

/**
 * @param {string} bucketOrMetricKey
 * @returns {typeof MIS_DELIVERY_METRICS[string] | null}
 */
export function getMetricRule(bucketOrMetricKey) {
  const key = DRAWER_BUCKET_TO_METRIC[bucketOrMetricKey] || bucketOrMetricKey;
  return MIS_DELIVERY_METRICS[key] ?? null;
}
