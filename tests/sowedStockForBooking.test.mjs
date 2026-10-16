import test from "node:test";
import assert from "node:assert/strict";
import { sowedStockForBooking } from "../utility/lagwadSlotPlantsSplit.js";
import { applySowingAllowedSlotMetrics } from "../utility/pastDueSlotMetrics.js";

test("sowedStockForBooking: 90% survivors minus order cover is free, 10% stays mortality", () => {
  assert.deepEqual(sowedStockForBooking(12000, 10000), {
    actualPlants: 10800,
    expectedMortality: 1200,
    free: 800,
  });
  assert.deepEqual(sowedStockForBooking(2000, 0), {
    actualPlants: 1800,
    expectedMortality: 200,
    free: 1800,
  });
  assert.equal(sowedStockForBooking(21000, 21000).free, 0);
  assert.equal(sowedStockForBooking(0, 0).free, 0);
});

test("sowedStockForBooking: covering orders from free never eats the mortality reserve", () => {
  const before = sowedStockForBooking(2000, 0);
  const after = sowedStockForBooking(2000, before.free);
  assert.equal(after.free, 0);
  assert.equal(after.expectedMortality, 200);
});

test("applySowingAllowedSlotMetrics: excess for booking uses survivors, not gross sowed", () => {
  const slot = applySowingAllowedSlotMetrics({
    primarySowed: 12000,
    sowingBatches: [{ orderCoveredPlants: 10000 }],
  });
  assert.equal(slot.excessAvailableForBooking, 800);
  assert.equal(slot.sowedActualPlants, 10800);
  assert.equal(slot.sowedExpectedMortality, 1200);
});
