import test from "node:test";
import assert from "node:assert/strict";
import {
  statusToDeliveryBucket,
  pivotDeliveryByDay,
  buildAdminDailyMisPayload,
  buildVarietyTable,
  buildPersonBreakdownTable,
  emptyDeliveryDay,
} from "../utility/adminDailyMisMerge.js";
import {
  buildAdminDailyMisPayloadFromMetrics,
  buildBreakdownTableFromMetrics,
} from "../utility/adminMisMetrics.js";
import { generateIstDateKeys, parseYmdRange } from "../utility/istOrderDateStats.js";

test("statusToDeliveryBucket maps known statuses", () => {
  assert.equal(statusToDeliveryBucket("ACCEPTED"), "accepted");
  assert.equal(statusToDeliveryBucket("FARM_READY"), "farmReady");
  assert.equal(statusToDeliveryBucket("READY_FOR_DISPATCH"), "readyForDispatch");
  assert.equal(statusToDeliveryBucket("PENDING"), "other");
});

test("pivotDeliveryByDay groups by day and status", () => {
  const map = pivotDeliveryByDay([
    {
      _id: { day: "2026-05-26", status: "FARM_READY" },
      orders: 2,
      plants: 100,
      plantsRemaining: 0,
    },
    {
      _id: { day: "2026-05-26", status: "READY_FOR_DISPATCH" },
      orders: 1,
      plants: 50,
      plantsRemaining: 50,
    },
    {
      _id: { day: "2026-05-27", status: "ACCEPTED" },
      orders: 3,
      plants: 200,
      plantsRemaining: 0,
    },
  ]);

  const d26 = map.get("2026-05-26");
  assert.equal(d26.farmReady.orders, 2);
  assert.equal(d26.readyForDispatch.orders, 1);
  assert.equal(d26.readyForDispatch.plantsRemaining, 50);
  assert.equal(d26.total.orders, 3);
  assert.equal(d26.total.plants, 150);

  const d27 = map.get("2026-05-27");
  assert.equal(d27.accepted.orders, 3);
});

test("buildAdminDailyMisPayload fills gaps and sums totals", () => {
  const dateKeys = ["2026-05-25", "2026-05-26"];
  const payload = buildAdminDailyMisPayload({
    dateKeys,
    bookingRows: [{ _id: "2026-05-26", orders: 5, plants: 1200 }],
    deliveryRows: [
      {
        _id: { day: "2026-05-26", status: "ACCEPTED" },
        orders: 2,
        plants: 400,
        plantsRemaining: 0,
      },
    ],
    uniquePerDayRows: [
      { _id: "2026-05-25", uniqueOrders: 1 },
      { _id: "2026-05-26", uniqueOrders: 6 },
    ],
    rangeUniqueOrders: 7,
  });

  assert.equal(payload.days.length, 2);
  assert.equal(payload.days[0].booking.orders, 0);
  assert.equal(payload.days[1].booking.orders, 5);
  assert.equal(payload.days[1].delivery.accepted.orders, 2);
  assert.equal(payload.days[1].uniqueOrders, 6);
  assert.equal(payload.totals.booking.orders, 5);
  assert.equal(payload.totals.uniqueOrders, 7);
});

test("parseYmdRange allows long ranges", () => {
  const parsed = parseYmdRange("2026-01-01", "2026-06-30");
  assert.ok(!parsed.error);
  assert.ok(parsed.dayCount > 31);
  assert.equal(parsed.dateKeys.length, parsed.dayCount);
});

test("generateIstDateKeys is inclusive", () => {
  const keys = generateIstDateKeys("2026-05-24", "2026-05-26");
  assert.deepEqual(keys, ["2026-05-24", "2026-05-25", "2026-05-26"]);
});

test("emptyDeliveryDay total starts at zero", () => {
  const d = emptyDeliveryDay();
  assert.equal(d.total.orders, 0);
  assert.equal(d.total.plants, 0);
});

test("buildVarietyTable merges booking and delivery by plant subtype", () => {
  const { rows, totals } = buildVarietyTable(
    [{ plantName: "Tomato", subtype: "Hybrid", bookingOrders: 3, bookingPlants: 300 }],
    [
      {
        _id: { plantName: "Tomato", subtype: "Hybrid", status: "FARM_READY" },
        orders: 2,
        plants: 200,
        plantsRemaining: 0,
      },
    ]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].booking.orders, 3);
  assert.equal(rows[0].delivery.farmReady.orders, 2);
  assert.equal(totals.booking.plants, 300);
});

test("buildAdminDailyMisPayloadFromMetrics uses global FR/RFD and transition dispatched", () => {
  const globalFarmReady = { orders: 5, plants: 500 };
  const globalRfd = { orders: 2, plants: 200 };
  const acceptedByDay = new Map([["2026-05-26", { orders: 1, plants: 100 }]]);
  const dispatchedByDay = new Map([["2026-05-26", { orders: 3, plants: 300 }]]);
  const completedByDay = new Map();
  const pipelineByDay = new Map();
  const deliveryInRangeByDay = new Map([
    ["2026-05-26", { orders: 4, plants: 400 }],
  ]);
  const deliveryUnionTotal = { orders: 10, plants: 1000 };

  const payload = buildAdminDailyMisPayloadFromMetrics({
    dateKeys: ["2026-05-26"],
    bookingRows: [{ _id: "2026-05-26", orders: 2, plants: 250 }],
    uniquePerDayRows: [],
    rangeUniqueOrders: 0,
    globalFarmReady,
    globalRfd,
    acceptedByDay,
    dispatchedByDay,
    completedByDay,
    pipelineByDay,
    deliveryInRangeByDay,
    deliveryUnionTotal,
  });

  const day = payload.days[0];
  assert.equal(day.delivery.farmReady.orders, 5);
  assert.equal(day.delivery.readyForDispatch.orders, 2);
  assert.equal(day.delivery.dispatched.orders, 3);
  assert.equal(day.delivery.accepted.orders, 1);
  assert.equal(day.delivery.total.orders, 4);
  assert.equal(payload.totals.delivery.total.orders, 10);
  assert.equal(payload.totals.delivery.farmReady.orders, 5);
});

test("buildPersonBreakdownTable merges booking and delivery by person", () => {
  const { rows, totals } = buildPersonBreakdownTable(
    [
      {
        personId: "507f1f77bcf86cd799439011",
        personName: "Ravi Sales",
        bookingOrders: 4,
        bookingPlants: 400,
      },
    ],
    [
      {
        _id: {
          personId: "507f1f77bcf86cd799439011",
          personName: "Ravi Sales",
          status: "ACCEPTED",
        },
        orders: 2,
        plants: 200,
        plantsRemaining: 0,
      },
    ]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].personName, "Ravi Sales");
  assert.equal(rows[0].booking.orders, 4);
  assert.equal(rows[0].delivery.accepted.orders, 2);
  assert.equal(totals.booking.plants, 400);
});

test("buildBreakdownTableFromMetrics keeps plant labels from delivery when booking empty", () => {
  const plantId = "507f1f77bcf86cd799439011";
  const subtypeId = "507f1f77bcf86cd799439012";
  const entityKeyFn = (row) => {
    const id = row._id ?? row;
    const pid = id.plantId ?? row.plantId;
    const sid = id.subtypeId ?? row.subtypeId;
    if (pid == null || sid == null) return "";
    return `${String(pid)}:${String(sid)}`;
  };
  const labelFromKey = (key, booking, metricMeta) => {
    const id = metricMeta ?? booking ?? {};
    const parts = String(key).split(":");
    return {
      plantName: booking?.plantName ?? id.plantName ?? "Unknown",
      subtype: booking?.subtype ?? id.subtype ?? "Other",
      plantId: booking?.plantId ?? id.plantId ?? parts[0],
      subtypeId: booking?.subtypeId ?? id.subtypeId ?? parts[1],
    };
  };

  const { rows } = buildBreakdownTableFromMetrics({
    bookingRows: [],
    entityKeyFn,
    labelFromKey,
    deliveryInRangeRows: [
      {
        _id: {
          plantName: "Banana",
          subtype: "G-9",
          plantId,
          subtypeId,
        },
        orders: 2,
        plants: 500,
      },
    ],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].plantName, "Banana");
  assert.equal(rows[0].subtype, "G-9");
  assert.equal(rows[0].booking.orders, 0);
  assert.equal(rows[0].delivery.total.orders, 2);
});
