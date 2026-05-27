import test from "node:test";
import assert from "node:assert/strict";
import {
  runCentralReport,
  listCentralReports,
  getCentralReportEngineMeta,
  normalizeReportId,
  getMetricRule,
  MIS_DELIVERY_METRICS,
  MIS_TRANSITION_RESOLUTION_ORDER,
  DELIVERY_TOTAL_EXCLUDED_STATUSES,
  matchDeliveryDateInRange,
  MIS_DATE_RANGE_POLICY,
  parseCentralReportDateRange,
} from "../utility/centralReportEngine/index.js";
import {
  resolveCentralReport,
  CENTRAL_REPORT_REGISTRY,
} from "../utility/centralReportEngine/reportRegistry.js";
import { buildAdminDailyMisPayloadFromMetrics } from "../utility/adminMisMetrics.js";

test("normalizeReportId handles aliases", () => {
  assert.equal(normalizeReportId("admin_daily_mis"), "admin-daily-mis");
  assert.equal(normalizeReportId("  Daily MIS  "), "daily-mis");
});

test("resolveCentralReport finds by id and alias", () => {
  assert.equal(resolveCentralReport("admin-daily-mis")?.id, "admin-daily-mis");
  assert.equal(resolveCentralReport("daily")?.id, "admin-daily-mis");
  assert.equal(resolveCentralReport("sales")?.id, "admin-mis-sales");
  assert.equal(resolveCentralReport("dealer")?.id, "admin-mis-dealer");
  assert.equal(resolveCentralReport("due")?.id, "admin-mis-due");
  assert.equal(resolveCentralReport("unknown-xyz"), null);
});

test("listCentralReports returns all registry entries", () => {
  const list = listCentralReports();
  assert.equal(list.length, Object.keys(CENTRAL_REPORT_REGISTRY).length);
  assert.ok(list.some((r) => r.id === "admin-daily-mis"));
});

test("getCentralReportEngineMeta includes metric rules", () => {
  const meta = getCentralReportEngineMeta();
  assert.equal(meta.timezone, "Asia/Kolkata");
  assert.ok(meta.metricRules.accepted);
  assert.ok(meta.reports.length >= 4);
  assert.deepEqual(meta.deliveryExcludedStatuses, ["DISPATCHED", "COMPLETED"]);
  assert.deepEqual(meta.metricRules.deliveryTotal.excludedStatuses, [
    "DISPATCHED",
    "COMPLETED",
  ]);
  assert.equal(meta.dateRangePolicy?.allowFutureStart, true);
});

test("getMetricRule maps drawer buckets", () => {
  assert.equal(getMetricRule("dispatched")?.kind, "status_transition");
  assert.equal(getMetricRule("farmReady")?.status, "FARM_READY");
});

test("parseCentralReportDateRange allows future start and end", () => {
  assert.equal(MIS_DATE_RANGE_POLICY.allowFutureStart, true);
  assert.equal(MIS_DATE_RANGE_POLICY.allowFutureEnd, true);
  const parsed = parseCentralReportDateRange("2026-08-01", "2026-08-31");
  assert.ok(!parsed.error);
  assert.equal(parsed.startYmd, "2026-08-01");
  assert.equal(parsed.endYmd, "2026-08-31");
  assert.equal(parsed.dateKeys.length, 31);
});

test("matchDeliveryDateInRange excludes dispatched and completed", () => {
  assert.ok(DELIVERY_TOTAL_EXCLUDED_STATUSES.includes("DISPATCHED"));
  assert.ok(DELIVERY_TOTAL_EXCLUDED_STATUSES.includes("COMPLETED"));
  const clause = matchDeliveryDateInRange(new Date("2026-05-01"), new Date("2026-05-07"));
  assert.ok(clause.orderStatus.$nin.includes("DISPATCHED"));
  assert.ok(clause.orderStatus.$nin.includes("COMPLETED"));
});

test("status_transition metrics resolve events before legacy", () => {
  assert.deepEqual(getMetricRule("dispatched")?.resolutionOrder, [
    ...MIS_TRANSITION_RESOLUTION_ORDER,
  ]);
  assert.equal(MIS_TRANSITION_RESOLUTION_ORDER[0], "order_event");
  assert.equal(MIS_TRANSITION_RESOLUTION_ORDER[2], "legacy_updated_at");
});

test("runCentralReport rejects unknown report", async () => {
  const result = await runCentralReport("not-a-report", "2026-05-01", "2026-05-07");
  assert.ok(result.error);
  assert.equal(result.statusCode, 400);
});

test("MIS metric rules cover all delivery drawer buckets", () => {
  const buckets = [
    "deliveryTotal",
    "accepted",
    "farmReady",
    "readyForDispatch",
    "dispatchProcess",
    "partiallyCompleted",
    "dispatched",
    "completed",
    "other",
    "yetToDispatch",
  ];
  for (const b of buckets) {
    assert.ok(getMetricRule(b), `missing rule for ${b}`);
  }
});

test("engine metric rules align with buildAdminDailyMisPayloadFromMetrics", () => {
  const payload = buildAdminDailyMisPayloadFromMetrics({
    dateKeys: ["2026-05-26"],
    bookingRows: [],
    uniquePerDayRows: [],
    rangeUniqueOrders: 0,
    globalFarmReady: { orders: 1, plants: 10 },
    globalRfd: { orders: 2, plants: 20 },
    acceptedByDay: new Map(),
    dispatchedByDay: new Map([["2026-05-26", { orders: 3, plants: 30 }]]),
    completedByDay: new Map(),
    pipelineByDay: new Map(),
    deliveryInRangeByDay: new Map(),
    deliveryUnionTotal: { orders: 5, plants: 50 },
  });

  assert.equal(
    getMetricRule("farmReady").kind,
    "global_status"
  );
  assert.equal(payload.days[0].delivery.farmReady.orders, 1);
  assert.equal(
    getMetricRule("dispatched").transitionStatus,
    "DISPATCHED"
  );
  assert.equal(payload.days[0].delivery.dispatched.orders, 3);
  assert.equal(
    MIS_DELIVERY_METRICS.deliveryTotal.kind,
    "delivery_union"
  );
});
