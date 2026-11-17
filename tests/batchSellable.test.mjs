import test from "node:test";
import assert from "node:assert/strict";
import {
  availablePlantsOf,
  dispatchedPlantsOf,
  sellablePlantsOf,
} from "../services/sowBatchStock.service.js";

test("sellable is plants sowed minus the mortality still held", () => {
  const batch = {
    plantsSowed: 1000,
    bufferPlants: 100,
    sowingBufferPct: 10,
    dispatchLog: [],
  };
  assert.equal(sellablePlantsOf(batch), 900);
  assert.equal(dispatchedPlantsOf(batch), 0);
  assert.equal(availablePlantsOf(batch), 900);
});

test("available subtracts dispatched once, and an unload comes back", () => {
  const batch = {
    plantsSowed: 1000,
    bufferPlants: 100,
    dispatchLog: [
      { plants: 200, bucket: "FREE", secondaryOutwardId: "out-1" },
      { plants: -50, bucket: "UNLOAD" },
    ],
  };
  assert.equal(sellablePlantsOf(batch), 900);
  assert.equal(dispatchedPlantsOf(batch), 150);
  assert.equal(availablePlantsOf(batch), 750);
});

test("a booking link does not reduce available", () => {
  const batch = {
    plantsSowed: 2100,
    bufferPlants: 252,
    dispatchLog: [
      {
        plants: 2300,
        bucket: "SWITCH",
        reason: "Order loaded from another batch · 2300 plants",
      },
    ],
  };
  assert.equal(sellablePlantsOf(batch), 1848);
  assert.equal(dispatchedPlantsOf(batch), 0);
  assert.equal(availablePlantsOf(batch), 1848);
});

test("no mortality reserve leaves the sow sellable", () => {
  const batch = {
    plantsSowed: 280,
    noMortalityReserve: true,
    bufferPlants: 28,
    dispatchLog: [{ plants: 280, bucket: "COVER", secondaryOutwardId: "out-2" }],
  };
  assert.equal(sellablePlantsOf(batch), 280);
  assert.equal(availablePlantsOf(batch), 0);
});
