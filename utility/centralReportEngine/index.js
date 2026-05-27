import {
  resolveCentralReport,
  listCentralReports,
  getCentralReportEngineMeta,
  normalizeReportId,
  CENTRAL_REPORT_REGISTRY,
} from "./reportRegistry.js";
import {
  MIS_DELIVERY_METRICS,
  MIS_DELIVERY_METRIC_KEYS,
  MIS_TIMEZONE,
  MIS_TRANSITION_RESOLUTION_ORDER,
  getMetricRule,
  DRAWER_BUCKET_TO_METRIC,
  DELIVERY_TOTAL_EXCLUDED_STATUSES,
  matchDeliveryDateInRange,
} from "./metricRules.js";
import {
  MIS_DATE_RANGE_POLICY,
  parseCentralReportDateRange,
  getIstTodayYmd,
} from "./dateRange.js";

export {
  resolveCentralReport,
  listCentralReports,
  getCentralReportEngineMeta,
  normalizeReportId,
  CENTRAL_REPORT_REGISTRY,
  MIS_DELIVERY_METRICS,
  MIS_DELIVERY_METRIC_KEYS,
  MIS_TIMEZONE,
  MIS_TRANSITION_RESOLUTION_ORDER,
  getMetricRule,
  DRAWER_BUCKET_TO_METRIC,
  DELIVERY_TOTAL_EXCLUDED_STATUSES,
  matchDeliveryDateInRange,
  MIS_DATE_RANGE_POLICY,
  parseCentralReportDateRange,
  getIstTodayYmd,
};

/**
 * Run any registered central report by id or alias.
 *
 * @example
 * await runCentralReport('admin-daily-mis', '2026-05-01', '2026-05-07');
 * await runCentralReport('sales', '2026-05-01', '2026-05-07', { dueOnly: true });
 *
 * @param {string} reportId
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @param {object} [options]
 * @returns {Promise<{ data?: object, error?: string, statusCode?: number, reportId?: string }>}
 */
export async function runCentralReport(reportId, startDate, endDate, options = {}) {
  const def = resolveCentralReport(reportId);
  if (!def) {
    const known = listCentralReports().map((r) => r.id).join(", ");
    return {
      error: `Unknown report "${reportId}". Known: ${known}`,
      statusCode: 400,
    };
  }
  const result = await def.run(startDate, endDate, options);
  if (result.error) {
    return { ...result, reportId: def.id };
  }
  return {
    ...result,
    reportId: def.id,
    reportTitle: def.title,
    layout: def.layout,
  };
}
