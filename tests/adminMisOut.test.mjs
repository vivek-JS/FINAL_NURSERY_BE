import test from "node:test";
import assert from "node:assert/strict";
import { buildMisOrdersMatch } from "../services/adminMisOrders.service.js";
import { buildAdminDailyMisPayloadFromMetrics } from "../utility/adminMisMetrics.js";
import {
  LEGACY_ORDER_STATUS_FOR_TRANSITION,
  transitionHistoryByDayStages,
} from "../utility/misTransitionMetrics.js";
import { istDayBoundsFromYmd } from "../utility/istOrderDateStats.js";

const window = {
  rangeStart: istDayBoundsFromYmd("2026-05-26").start,
  rangeEnd: istDayBoundsFromYmd("2026-05-26").end,
};

test("Out column maps to bucket dispatched and transition DISPATCHED", () => {
  const m = buildMisOrdersMatch({ bucket: "dispatched", mode: "delivery" }, window);
  assert.equal(m.kind, "transition");
  assert.equal(m.newStatus, "DISPATCHED");
});

test("Out drawer is not blocked by dueOnly", () => {
  const m = buildMisOrdersMatch(
    { bucket: "dispatched", mode: "delivery", dueOnly: "true" },
    window
  );
  assert.equal(m.kind, "transition");
  assert.equal(m.newStatus, "DISPATCHED");
});

test("legacy Out includes DISPATCHED COMPLETED PARTIALLY_COMPLETED", () => {
  const legacy = LEGACY_ORDER_STATUS_FOR_TRANSITION.DISPATCHED;
  assert.ok(legacy.includes("DISPATCHED"));
  assert.ok(legacy.includes("COMPLETED"));
  assert.ok(legacy.includes("PARTIALLY_COMPLETED"));
});

test("transitionHistoryByDayStages supports Out (DISPATCHED)", () => {
  const stages = transitionHistoryByDayStages(
    "DISPATCHED",
    window.rangeStart,
    window.rangeEnd
  );
  assert.ok(stages.some((s) => s.$unwind === "$_misSc"));
});

test("buildAdminDailyMisPayloadFromMetrics sums Out across days in totals", () => {
  const dispatchedByDay = new Map([
    ["2026-05-25", { orders: 2, plants: 200 }],
    ["2026-05-26", { orders: 3, plants: 300 }],
  ]);

  const payload = buildAdminDailyMisPayloadFromMetrics({
    dateKeys: ["2026-05-25", "2026-05-26"],
    bookingRows: [],
    uniquePerDayRows: [],
    rangeUniqueOrders: 0,
    globalFarmReady: { orders: 0, plants: 0 },
    globalRfd: { orders: 0, plants: 0 },
    acceptedByDay: new Map(),
    dispatchedByDay,
    vehicleDispatchedByDay: new Map([
      ["2026-05-25", { orders: 1, plants: 100 }],
      ["2026-05-26", { orders: 2, plants: 150 }],
    ]),
    completedByDay: new Map(),
    pipelineByDay: new Map(),
    deliveryInRangeByDay: new Map(),
    deliveryUnionTotal: { orders: 0, plants: 0 },
  });

  assert.equal(payload.days[0].delivery.dispatched.orders, 2);
  assert.equal(payload.days[1].delivery.dispatched.orders, 3);
  assert.equal(payload.totals.delivery.dispatched.orders, 5);
  assert.equal(payload.totals.delivery.dispatched.plants, 500);
  assert.equal(payload.days[0].delivery.vehicleDispatched.orders, 1);
  assert.equal(payload.days[1].delivery.vehicleDispatched.orders, 2);
  assert.equal(payload.totals.delivery.vehicleDispatched.orders, 3);
  assert.equal(payload.totals.delivery.vehicleDispatched.plants, 250);
});

test("Out per-day cell uses transition day not delivery day", () => {
  const dispatchedByDay = new Map([["2026-05-26", { orders: 1, plants: 100 }]]);
  const deliveryInRangeByDay = new Map([
    ["2026-05-27", { orders: 9, plants: 900 }],
  ]);

  const payload = buildAdminDailyMisPayloadFromMetrics({
    dateKeys: ["2026-05-26", "2026-05-27"],
    bookingRows: [],
    uniquePerDayRows: [],
    rangeUniqueOrders: 0,
    globalFarmReady: { orders: 0, plants: 0 },
    globalRfd: { orders: 0, plants: 0 },
    acceptedByDay: new Map(),
    dispatchedByDay,
    vehicleDispatchedByDay: new Map(),
    completedByDay: new Map(),
    pipelineByDay: new Map(),
    deliveryInRangeByDay,
    deliveryUnionTotal: { orders: 9, plants: 900 },
  });

  assert.equal(payload.days[0].delivery.dispatched.orders, 1);
  assert.equal(payload.days[1].delivery.dispatched.orders, 0);
  assert.equal(payload.days[1].delivery.total.orders, 9);
});
