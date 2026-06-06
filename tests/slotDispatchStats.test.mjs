import { describe, it } from "node:test";
import assert from "node:assert";
import {
  addRolledRemainingToStats,
  computeBookedPlantsFromOrders,
  computeSlotDispatchStatsFromOrders,
  groupOrdersByDeliverySlot,
} from "../utility/slotDispatchStats.js";

describe("slotDispatchStats — booked by delivery date", () => {
  it("counts delivery in window and excludes rolled-in even if bookingSlot matches", () => {
    const slots = [
      { _id: "slot-june", startDay: "16-06-2026", endDay: "30-06-2026" },
    ];
    const orders = [
      {
        orderStatus: "ACCEPTED",
        numberOfPlants: 2000,
        pastDueSlotRollover: false,
        deliveryDate: new Date("2026-06-20T00:00:00.000Z"),
        bookingSlot: "slot-june",
      },
      {
        orderStatus: "ACCEPTED",
        numberOfPlants: 8000,
        pastDueSlotRollover: true,
        pastDueSlotRolloverAt: new Date("2026-06-18T00:00:00.000Z"),
        deliveryDate: new Date("2026-06-20T00:00:00.000Z"),
        bookingSlot: "slot-june",
      },
      {
        orderStatus: "ACCEPTED",
        numberOfPlants: 5000,
        pastDueSlotRollover: false,
        deliveryDate: new Date("2026-05-10T00:00:00.000Z"),
        bookingSlot: "slot-june",
      },
    ];
    const byDelivery = groupOrdersByDeliverySlot(orders, slots);
    assert.strictEqual(computeBookedPlantsFromOrders(byDelivery.get("slot-june")), 2000);
    const native = byDelivery.get("slot-june").filter((o) => !o.pastDueSlotRollover);
    const pipeline = computeSlotDispatchStatsFromOrders(
      orders.filter((o) => o.bookingSlot === "slot-june"),
      { bookedOrders: native, pipelineOrders: native }
    );
    assert.strictEqual(pipeline.totalBookedPlants, 2000);
    assert.strictEqual(pipeline.remainingToDispatch, 2000);
  });
});

describe("slotDispatchStats — booked native only", () => {
  it("totalBookedPlants excludes past-due rolled-in orders", () => {
    const native = [
      { orderStatus: "ACCEPTED", numberOfPlants: 1000, pastDueSlotRollover: false },
    ];
    const stats = computeSlotDispatchStatsFromOrders(
      [
        { orderStatus: "ACCEPTED", numberOfPlants: 1000, pastDueSlotRollover: false },
        { orderStatus: "ACCEPTED", numberOfPlants: 5000, pastDueSlotRollover: true },
        { orderStatus: "DISPATCHED", numberOfPlants: 2000, pastDueSlotRollover: true },
      ],
      { bookedOrders: native, pipelineOrders: native }
    );

    assert.strictEqual(stats.totalBookedPlants, 1000);
    assert.strictEqual(stats.totalDispatchedPlants, 0);
    assert.strictEqual(stats.remainingToDispatch, 1000);
  });

  it("card remaining matches native delivery cohort; rolled tracked separately", () => {
    const orders = [
      { orderStatus: "ACCEPTED", numberOfPlants: 3000, pastDueSlotRollover: true },
      { orderStatus: "FARM_READY", numberOfPlants: 700, pastDueSlotRollover: false },
    ];
    const native = orders.filter((o) => !o.pastDueSlotRollover);
    const stats = computeSlotDispatchStatsFromOrders(orders, {
      bookedOrders: native,
      pipelineOrders: native,
    });
    addRolledRemainingToStats(stats, orders);

    assert.strictEqual(stats.totalBookedPlants, 700);
    assert.strictEqual(stats.remainingRolledIn, 3000);
    assert.strictEqual(stats.remainingNative, 700);
    assert.strictEqual(stats.remainingToDispatch, 700);
  });
});
