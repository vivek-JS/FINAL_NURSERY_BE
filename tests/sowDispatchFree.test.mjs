import test from "node:test";
import assert from "node:assert/strict";
import { dispatchLoadableFree } from "../utility/sowDispatchFree.js";

test("dispatch free excludes unreleased mortality reserve", () => {
  assert.equal(
    dispatchLoadableFree({
      plantsSowed: 10000,
      orderCoveredPlants: 0,
      expectedMortalityApplied: 1200,
      availablePlantsApplied: 8800,
      sowingBufferPct: 12,
    }),
    8800
  );
});

test("released mortality becomes loadable, but irrelevant batches stay hidden", () => {
  assert.equal(
    dispatchLoadableFree({
      plantsSowed: 10000,
      orderCoveredPlants: 8000,
      expectedMortalityApplied: 700,
      mortalityMovedToExcess: 500,
      availablePlantsApplied: 1300,
      sowingBufferPct: 12,
    }),
    1300
  );
  assert.equal(
    dispatchLoadableFree({
      plantsSowed: 10000,
      orderCoveredPlants: 8000,
      expectedMortalityApplied: 0,
      noMortalityReserve: true,
    }),
    2000
  );
  assert.equal(
    dispatchLoadableFree({
      plantsSowed: 10000,
      expectedMortalityApplied: 0,
      noMortalityReserve: true,
      isIrrelevant: true,
    }),
    0
  );
});
