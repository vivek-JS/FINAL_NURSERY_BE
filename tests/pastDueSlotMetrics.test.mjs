import { describe, it } from "node:test";
import assert from "node:assert";
import {
  aggregatePastDueMetricsForSlotGroup,
  buildCrossSlotDetailBySlot,
  buildSlotOrderMetrics,
  computeSlotPhysicalMetrics,
  sumEarlyDispatchOntoSlot,
} from "../utility/pastDueSlotMetrics.js";
import {
  addRolledRemainingToStats,
  computeSlotDispatchStatsFromOrders,
} from "../utility/slotDispatchStats.js";

const CURRENT = "cccccccccccccccccccccccc";
const EXPIRED = "dddddddddddddddddddddddd";

describe("pastDueSlotMetrics — rolled-in on current slot only", () => {
  const asOf = new Date("2026-06-20T12:00:00+05:30");

  const slots = [
    {
      _id: EXPIRED,
      status: true,
      startDay: "01-05-2026",
      endDay: "15-05-2026",
    },
    {
      _id: CURRENT,
      status: true,
      startDay: "16-06-2026",
      endDay: "30-06-2026",
    },
  ];

  it("current-slot card uses rolledInOnCurrentSlot counts, not subtype-wide", () => {
    const ordersBySlot = new Map([
      [
        CURRENT,
        [
          { _id: "o1", orderId: 1, orderStatus: "ACCEPTED", numberOfPlants: 10000, pastDueSlotRollover: true },
          { _id: "o2", orderId: 2, orderStatus: "ACCEPTED", numberOfPlants: 5000, pastDueSlotRollover: true },
        ],
      ],
      [
        EXPIRED,
        [
          { _id: "o3", orderId: 3, orderStatus: "ACCEPTED", numberOfPlants: 8000, pastDueSlotRollover: true },
        ],
      ],
    ]);

    const group = aggregatePastDueMetricsForSlotGroup(slots, ordersBySlot, asOf);
    assert.strictEqual(group.currentSlotId, CURRENT);
    assert.strictEqual(group.pastDueRolledInPlants, 23000);
    assert.strictEqual(group.pastDueDetail.rolledInOnCurrentSlot.orderCount, 2);
    assert.strictEqual(group.pastDueDetail.rolledInOnCurrentSlot.plants, 15000);
    assert.strictEqual(group.pastDueDetail.rolledInOnOtherSlots.orderCount, 1);
    assert.strictEqual(group.pastDueDetail.rolledInOnOtherSlots.plants, 8000);

    const dispatchStats = computeSlotDispatchStatsFromOrders(ordersBySlot.get(CURRENT));
    const metrics = buildSlotOrderMetrics({
      slotId: CURRENT,
      dispatchStats,
      pastDueGroup: group,
      dispatchedFromOtherBySlot: new Map(),
      releasedForEarlyBySlot: new Map(),
    });

    assert.strictEqual(metrics.pastDueRolledInOrders, 2);
    assert.strictEqual(metrics.pastDueRolledInPlants, 15000);
    assert.strictEqual(metrics.pastDueRolledInPlantsSubtype, 23000);
    assert.strictEqual(metrics.totalBookedPlants, 0);
    assert.notStrictEqual(metrics.totalBookedPlants, metrics.pastDueRolledInPlants);
  });
});

describe("pastDueSlotMetrics — cross-slot detail", () => {
  it("buildCrossSlotDetailBySlot splits early-in vs released-out per slot", () => {
    const slotA = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const slotB = "bbbbbbbbbbbbbbbbbbbbbbbb";
    const slotMap = new Map([
      [slotA, { startDay: "01-06-2026", endDay: "07-06-2026" }],
      [slotB, { startDay: "08-06-2026", endDay: "14-06-2026" }],
    ]);
    const cross = [
      {
        _id: "o1",
        orderId: 101,
        orderStatus: "READY_FOR_DISPATCH",
        numberOfPlants: 500,
        bookingSlot: slotB,
        originalBookingSlot: slotA,
        dispatchedFromAnotherSlot: true,
        pastDueSlotRollover: false,
      },
      {
        _id: "o2",
        orderId: 102,
        orderStatus: "ACCEPTED",
        numberOfPlants: 200,
        bookingSlot: slotA,
        originalBookingSlot: slotA,
        dispatchedFromAnotherSlot: true,
        pastDueSlotRollover: true,
      },
    ];
    const detail = buildCrossSlotDetailBySlot(cross, slotMap);
    assert.strictEqual(detail.get(slotA).releasedOut.plants, 500);
    assert.strictEqual(detail.get(slotB).earlyDispatchIn.plants, 500);
    assert.strictEqual(detail.get(slotA).releasedOut.orderCount, 1);
    assert.strictEqual(detail.get(slotB).earlyDispatchIn.orders[0].fromSlotLabel, "01-06-2026–07-06-2026");
  });
});

describe("pastDueSlotMetrics — early dispatch vs rollover", () => {
  it("sumEarlyDispatchOntoSlot ignores past-due rollover rows", () => {
    const slotId = "eeeeeeeeeeeeeeeeeeeeeeee";
    const cross = [
      {
        bookingSlot: slotId,
        numberOfPlants: 131846,
        pastDueSlotRollover: true,
        dispatchedFromAnotherSlot: true,
      },
      {
        bookingSlot: slotId,
        numberOfPlants: 100,
        pastDueSlotRollover: false,
        dispatchedFromAnotherSlot: true,
      },
    ];
    const map = sumEarlyDispatchOntoSlot(cross, new Set([slotId]));
    assert.strictEqual(map.get(slotId), 100);
  });
});

describe("pastDueSlotMetrics — remaining split on slot row", () => {
  it("remainingRolledIn + remainingNative = remainingToDispatch", () => {
    const orders = [
      { orderStatus: "ACCEPTED", numberOfPlants: 7000, pastDueSlotRollover: true },
      { orderStatus: "ACCEPTED", numberOfPlants: 3000, pastDueSlotRollover: false },
    ];
    const native = orders.filter((o) => !o.pastDueSlotRollover);
    const dispatchStats = computeSlotDispatchStatsFromOrders(orders, {
      bookedOrders: native,
      pipelineOrders: native,
    });
    addRolledRemainingToStats(dispatchStats, orders);
    const metrics = buildSlotOrderMetrics({
      slotId: CURRENT,
      dispatchStats,
      pastDueGroup: {
        currentSlotId: CURRENT,
        pastDuePendingOnSlot: 0,
        pastDuePendingOrders: 0,
        pastDueRolledInPlants: 7000,
        pastDueDetail: {
          rolledInOnCurrentSlot: { orderCount: 1, plants: 7000, orders: [] },
        },
      },
      dispatchedFromOtherBySlot: new Map(),
      releasedForEarlyBySlot: new Map(),
    });

    assert.strictEqual(metrics.remainingToDispatch, 3000);
    assert.strictEqual(metrics.remainingRolledIn, 7000);
    assert.strictEqual(metrics.remainingNative, 3000);
  });

  it("buildSlotOrderMetrics attaches physical stock fields", () => {
    const dispatchStats = {
      totalBookedPlants: 100,
      totalDispatchedPlants: 0,
      remainingToDispatch: 500,
      remainingRolledIn: 200,
      remainingNative: 300,
    };
    const metrics = buildSlotOrderMetrics({
      slot: { actualPlants: 400, rolledInAvailablePlants: 50 },
      slotId: CURRENT,
      orders: [],
      dispatchStats,
      pastDueGroup: {
        currentSlotId: CURRENT,
        pastDuePendingOnSlot: 0,
        pastDuePendingOrders: 0,
        pastDueRolledInPlants: 0,
        pastDueDetail: null,
      },
      dispatchedFromOtherBySlot: new Map(),
      releasedForEarlyBySlot: new Map(),
    });
    assert.strictEqual(metrics.actualPlants, 400);
    assert.strictEqual(metrics.actualRemainingPlants, 500);
    assert.strictEqual(metrics.actualGapPlants, 100);
    assert.strictEqual(metrics.actualGapPct, 25);
    assert.strictEqual(metrics.rolledInAvailablePlants, 50);
  });
});
