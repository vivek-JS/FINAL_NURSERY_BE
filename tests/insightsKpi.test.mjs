import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDispatchKpiSummary,
  istYmdFromValue,
  istAddDaysYmd,
  isOpenForExpectedKpi,
  KPI_DELIVERY_LOOKAHEAD_DAYS,
} from "../utility/insightsKpi.js";

const REPORT = "2026-05-26";

function order(overrides) {
  return {
    id: overrides.id || "ORD-1",
    orderId: overrides.orderId ?? 1,
    farmerName: "Test Farmer",
    qty: overrides.qty ?? 1000,
    remainingPlants: overrides.remainingPlants ?? overrides.qty ?? 1000,
    rawOrderStatus: overrides.rawOrderStatus ?? "ACCEPTED",
    deliveryDate: overrides.deliveryDate,
    district: "Pune",
    taluka: "Haveli",
    village: "Wagholi",
    ...overrides,
  };
}

test("istYmdFromValue parses ISO delivery dates in IST", () => {
  const ymd = istYmdFromValue("2026-05-26T00:00:00.000Z");
  assert.ok(ymd);
});

test("computeDispatchKpiSummary buckets by delivery date", () => {
  const orders = [
    order({
      id: "ORD-1",
      deliveryDate: "2026-05-26T12:00:00+05:30",
      rawOrderStatus: "ACCEPTED",
      remainingPlants: 500,
    }),
    order({
      id: "ORD-2",
      deliveryDate: "2026-05-20T12:00:00+05:30",
      rawOrderStatus: "FARM_READY",
      remainingPlants: 300,
    }),
    order({
      id: "ORD-3",
      deliveryDate: "2026-05-28T12:00:00+05:30",
      rawOrderStatus: "READY_FOR_DISPATCH",
      remainingPlants: 200,
    }),
    order({
      id: "ORD-4",
      deliveryDate: "2026-05-26T12:00:00+05:30",
      rawOrderStatus: "DISPATCHED",
      remainingPlants: 100,
    }),
  ];

  const summary = computeDispatchKpiSummary(orders, [], REPORT);

  assert.equal(summary.todayExpected.orderCount, 1);
  assert.equal(summary.todayExpected.plantCount, 500);
  assert.equal(summary.due.orderCount, 1);
  assert.equal(summary.due.plantCount, 300);
  assert.equal(summary.next7Expected.orderCount, 1);
  assert.equal(summary.next7Expected.plantCount, 200);
});

test("excludeReadyForDispatch removes READY_FOR_DISPATCH from expected", () => {
  const orders = [
    order({
      id: "ORD-5",
      deliveryDate: "2026-05-26T12:00:00+05:30",
      rawOrderStatus: "READY_FOR_DISPATCH",
    }),
  ];
  const withReady = computeDispatchKpiSummary(orders, [], REPORT);
  assert.equal(withReady.todayExpected.orderCount, 1);

  const without = computeDispatchKpiSummary(orders, [], REPORT, {
    excludeReadyForDispatch: true,
  });
  assert.equal(without.todayExpected.orderCount, 0);
});

test("weekSchedule actualReady counts READY_FOR_DISPATCH by delivery day", () => {
  const orders = [
    order({
      id: "ORD-6",
      deliveryDate: "2026-05-27T12:00:00+05:30",
      rawOrderStatus: "READY_FOR_DISPATCH",
      remainingPlants: 400,
    }),
  ];
  const summary = computeDispatchKpiSummary(orders, [], REPORT);
  const day1 = summary.weekSchedule.find((d) => d.date === "2026-05-27");
  assert.ok(day1);
  assert.equal(day1.actualReady.orderCount, 1);
  assert.equal(day1.actualReady.plantCount, 400);
  assert.equal(day1.expected.orderCount, 1);
});

test("todayActual resolves orders from dispatch orderIds", () => {
  const mongoId = "507f1f77bcf86cd799439011";
  const orders = [
    order({
      mongoId,
      id: "ORD-99",
      orderId: 99,
      deliveryDate: "2026-05-26T12:00:00+05:30",
      rawOrderStatus: "DISPATCHED",
      remainingPlants: 150,
    }),
  ];
  const dispatches = [
    {
      id: "DSP-1",
      date: "2026-05-26T06:00:00+05:30",
      totalPlants: 150,
      orders: 1,
      orderIds: [mongoId],
      vehicle: "MH-12",
      driver: "Driver",
      status: "scheduled",
    },
  ];
  const orderByMongoId = new Map([[mongoId, orders[0]]]);
  const summary = computeDispatchKpiSummary(orders, dispatches, REPORT, {
    orderByMongoId,
  });
  assert.equal(summary.todayActual.dispatchCount, 1);
  assert.equal(summary.todayActual.orders.length, 1);
  assert.equal(summary.todayActual.orders[0].orderId, 99);
});

test("isOpenForExpectedKpi excludes closed statuses", () => {
  assert.equal(isOpenForExpectedKpi({ rawOrderStatus: "ACCEPTED" }, false), true);
  assert.equal(isOpenForExpectedKpi({ rawOrderStatus: "DISPATCHED" }, false), false);
});

test("next7 window respects KPI_DELIVERY_LOOKAHEAD_DAYS", () => {
  const far = order({
    id: "ORD-far",
    deliveryDate: `${istAddDaysYmd(REPORT, KPI_DELIVERY_LOOKAHEAD_DAYS + 2)}T12:00:00+05:30`,
    rawOrderStatus: "ACCEPTED",
  });
  const summary = computeDispatchKpiSummary([far], [], REPORT);
  assert.equal(summary.next7Expected.orderCount, 0);
});
