import test from "node:test";
import assert from "node:assert/strict";
import {
  slotSowStock,
  sowBatchStock,
  sowMortalityReserve,
  sowQtySlotImpact,
} from "../utility/lagwadSlotPlantsSplit.js";
import { applySowingAllowedSlotMetrics } from "../utility/pastDueSlotMetrics.js";
import { computeSowingGapBoardMetricsForSubtype } from "../utility/sowingGapSummaryMetrics.js";

test("sowMortalityReserve: 10% floor, leftover kept up to 20% of order plants", () => {
  assert.equal(sowMortalityReserve(12000, 10000), 2000);
  assert.equal(sowMortalityReserve(15000, 10000), 2000);
  assert.equal(sowMortalityReserve(12000, 0), 1200);
  assert.equal(sowMortalityReserve(10000, 10000), 1000);
  assert.equal(sowMortalityReserve(11000, 10000), 1100);
});

test("sowQtySlotImpact: orders keep their plants, buffer is mortality, rest is saleable", () => {
  assert.deepEqual(sowQtySlotImpact(12000, { orderCoveredPlants: 10000, excessPlants: 2000 }), {
    plantsSowed: 12000,
    actualPlants: 10000,
    expectedMortality: 2000,
    availablePlants: 0,
    orderReservedPlants: 10000,
    excessPlants: 2000,
    orderCoveredPlants: 10000,
  });
  const more = sowQtySlotImpact(15000, { orderCoveredPlants: 10000, excessPlants: 5000 });
  assert.equal(more.expectedMortality, 2000);
  assert.equal(more.availablePlants, 3000);
  assert.equal(more.orderReservedPlants, 10000);
  const excess = sowQtySlotImpact(12000, { isExcess: true });
  assert.equal(excess.expectedMortality, 1200);
  assert.equal(excess.availablePlants, 10800);
  const applyStep = sowQtySlotImpact(12000);
  assert.equal(applyStep.actualPlants, 10800);
  assert.equal(applyStep.availablePlants, 0);
});

test("sowBatchStock: covering orders from excess later never eats the reserve", () => {
  const batch = { plantsSowed: 15000, orderCoveredPlants: 10000 };
  assert.deepEqual(sowBatchStock(batch), { sowed: 15000, covered: 10000, reserve: 2000, free: 3000 });
  const afterCover = sowBatchStock({
    ...batch,
    orderCoveredPlants: 13000,
    excessAllocations: [{ plants: 3000 }],
  });
  assert.equal(afterCover.reserve, 2000);
  assert.equal(afterCover.free, 0);
});

test("sowBatchStock: noMortalityReserve keeps the full sowed count sellable", () => {
  const batch = {
    plantsSowed: 28980,
    orderCoveredPlants: 14000,
    excessAllocations: [{ plants: 14000 }],
    noMortalityReserve: true,
  };
  assert.deepEqual(sowBatchStock(batch), { sowed: 28980, covered: 14000, reserve: 0, free: 14980 });
  const slot = { primarySowed: 28980, sowingBatches: [batch] };
  assert.deepEqual(slotSowStock(slot), { actualPlants: 28980, expectedMortality: 0, free: 14980 });
});

test("slotSowStock / applySowingAllowedSlotMetrics use the batch reserves", () => {
  const slot = {
    primarySowed: 24000,
    sowingBatches: [
      { plantsSowed: 12000, orderCoveredPlants: 10000 },
      { plantsSowed: 12000, orderCoveredPlants: 0, isExcessiveSowing: true },
    ],
  };
  assert.deepEqual(slotSowStock(slot), { actualPlants: 20800, expectedMortality: 3200, free: 10800 });
  const m = applySowingAllowedSlotMetrics({ ...slot }, 12);
  assert.equal(m.excessAvailableForBooking, 11120);
  assert.equal(m.sowedExpectedMortality, 3200);
  assert.equal(m.sowedActualPlants, 20800);
});

test("capacity board excess takes the CMS percent off sowed, then the orders", () => {
  const real = computeSowingGapBoardMetricsForSubtype(
    [
      {
        slotId: "s1",
        slotStartDay: "02-11-2026",
        slotEndDay: "02-11-2026",
        primarySowed: 112140,
        sowingBatches: [{ plantsSowed: 112140, orderCoveredPlants: 85500 }],
      },
    ],
    [],
    12
  );
  assert.equal(real.get("s1").sowedExpectedMortality, 17100);
  assert.equal(real.get("s1").excessAvailableForBooking, 13183);
});
