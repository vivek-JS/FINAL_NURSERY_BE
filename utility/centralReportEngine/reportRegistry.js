import { fetchAdminDailyMis } from "../../services/adminDailyMis.service.js";
import {
  fetchAdminSalesMis,
  fetchAdminDealerMis,
} from "../../services/adminMisBreakdown.service.js";
import { fetchAdminDueMis } from "../../services/adminMisDueTab.service.js";
import { fetchSlotAvailabilityReport } from "../../services/availabilityOverview.service.js";
import { fetchCeoOrderDeliveryFlow } from "../../modules/ceoReport/services/ceoOrderDeliveryFlow.service.js";
import { DELIVERY_TOTAL_EXCLUDED_STATUSES } from "./deliveryMatch.js";
import { MIS_DATE_RANGE_POLICY } from "./dateRange.js";
import {
  MIS_DELIVERY_METRICS,
  MIS_TIMEZONE,
  MIS_TRANSITION_RESOLUTION_ORDER,
} from "./metricRules.js";

/**
 * Registered central reports. Add new reports here — one command → one runner.
 * @type {Record<string, CentralReportDefinition>}
 */
export const CENTRAL_REPORT_REGISTRY = {
  "admin-daily-mis": {
    id: "admin-daily-mis",
    title: "Admin daily MIS",
    description: "Day-wise booking + delivery pipeline (IST).",
    apiPath: "/api/v1/order/admin-daily-mis",
    layout: "daily",
    run: fetchAdminDailyMis,
    aliases: ["daily", "daily-mis", "mis", "admin_daily_mis"],
  },
  "admin-mis-sales": {
    id: "admin-mis-sales",
    title: "Admin MIS — sales",
    description: "Per sales-person booking and delivery metrics.",
    apiPath: "/api/v1/order/admin-mis-sales",
    layout: "breakdown",
    groupBy: "salesPerson",
    run: fetchAdminSalesMis,
    aliases: ["sales", "mis-sales", "admin_sales_mis"],
  },
  "admin-mis-dealer": {
    id: "admin-mis-dealer",
    title: "Admin MIS — dealer",
    description: "Per dealer booking and delivery metrics.",
    apiPath: "/api/v1/order/admin-mis-dealer",
    layout: "breakdown",
    groupBy: "dealer",
    run: fetchAdminDealerMis,
    aliases: ["dealer", "mis-dealer", "admin_dealer_mis"],
  },
  "admin-mis-due": {
    id: "admin-mis-due",
    title: "Admin MIS — due orders",
    description: "Due pipeline tab: daily + sales + dealer with dueOnly.",
    apiPath: "/api/v1/order/admin-mis-due",
    layout: "due-tab",
    run: fetchAdminDueMis,
    aliases: ["due", "mis-due", "admin_due_mis"],
  },
  "ceo-order-delivery-flow": {
    id: "ceo-order-delivery-flow",
    title: "CEO — Order & Delivery Flow",
    description: "CEO report tab: booking, delivery pipeline, changes, geo.",
    apiPath: "/api/v1/ceo-report/order-delivery-flow",
    layout: "ceo-tab",
    run: (start, end, opts) => fetchCeoOrderDeliveryFlow({ startDate: start, endDate: end, ...opts }),
    aliases: ["ceo", "ceo-report", "ceo_order_delivery"],
  },
  "slot-availability": {
    id: "slot-availability",
    title: "Slot availability overview",
    description:
      "All plants × subtypes × slots for booking (year, optional month/plant/search).",
    apiPath: "/api/v1/slots/availability-overview",
    layout: "availability",
    run: fetchSlotAvailabilityReport,
    aliases: ["availability", "stock", "available-stock", "availability-overview"],
  },
};

/** @typedef {object} CentralReportDefinition
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {string} apiPath
 * @property {'daily'|'breakdown'|'due-tab'|'availability'} layout
 * @property {(startDate: string, endDate: string, options?: object) => Promise<{ data?: object, error?: string, statusCode?: number }>} run
 * @property {string[]} [aliases]
 * @property {string} [groupBy]
 */

const ALIAS_INDEX = new Map();
for (const def of Object.values(CENTRAL_REPORT_REGISTRY)) {
  ALIAS_INDEX.set(def.id, def.id);
  for (const alias of def.aliases || []) {
    ALIAS_INDEX.set(normalizeReportId(alias), def.id);
  }
}

/**
 * Normalize CLI / API report id (case, underscores, spaces).
 * @param {string} raw
 * @returns {string}
 */
export function normalizeReportId(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/_/g, "-");
}

/**
 * @param {string} reportId
 * @returns {CentralReportDefinition | null}
 */
export function resolveCentralReport(reportId) {
  const key = ALIAS_INDEX.get(normalizeReportId(reportId));
  if (!key) return null;
  return CENTRAL_REPORT_REGISTRY[key] ?? null;
}

/**
 * @returns {Array<{ id: string, title: string, description: string, apiPath: string, layout: string, aliases: string[] }>}
 */
export function listCentralReports() {
  return Object.values(CENTRAL_REPORT_REGISTRY).map((def) => ({
    id: def.id,
    title: def.title,
    description: def.description,
    apiPath: def.apiPath,
    layout: def.layout,
    groupBy: def.groupBy,
    aliases: def.aliases || [],
  }));
}

export function getCentralReportEngineMeta() {
  return {
    timezone: MIS_TIMEZONE,
    transitionResolutionOrder: MIS_TRANSITION_RESOLUTION_ORDER,
    deliveryExcludedStatuses: DELIVERY_TOTAL_EXCLUDED_STATUSES,
    dateRangePolicy: MIS_DATE_RANGE_POLICY,
    metricRules: MIS_DELIVERY_METRICS,
    reports: listCentralReports(),
  };
}
