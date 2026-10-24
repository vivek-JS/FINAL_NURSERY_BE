import test from "node:test";
import assert from "node:assert/strict";
import { planMortalityToExcess } from "../services/sowBatchMortalityRelease.service.js";

test("moves stored mortality into available plants", () => {
  const plan = planMortalityToExcess({
    slot: { actualPlants: 9000, expectedMortality: 1000, availablePlants: 2000, excessiveSowing: { plants: 0 } },
    batch: { expectedMortalityApplied: 1000, orderCoveredPlants: 8000, plantsSowed: 10000 },
  });
  assert.equal(plan.mort, 1000);
  assert.equal(plan.actualPlants, 10000);
  assert.equal(plan.expectedMortality, 0);
  assert.equal(plan.availablePlants, 3000);
  assert.equal(plan.addExcessive, false);
});

test("an excess sowing also grows the excessive bucket", () => {
  const plan = planMortalityToExcess({
    slot: { actualPlants: 900, expectedMortality: 100, availablePlants: 900, excessiveSowing: { plants: 900 } },
    batch: { plantsSowed: 1000, isExcessiveSowing: true, orderCoveredPlants: 0 },
  });
  assert.equal(plan.mort, 100);
  assert.equal(plan.excessivePlants, 1000);
});

test("moves only the amount asked, and refuses more than the screen shows", () => {
  const slot = { actualPlants: 68040, expectedMortality: 8900, availablePlants: 0, excessiveSowing: { plants: 0 } };
  const batch = {
    plantsSowed: 75600,
    orderCoveredPlants: 66700,
    expectedMortalityApplied: 7560,
  };
  const part = planMortalityToExcess({ slot, batch, plants: 2000 });
  assert.equal(part.mort, 2000);
  assert.equal(part.releaseAll, false);
  assert.equal(part.actualPlants, 70040);
  assert.equal(part.expectedMortality, 6900);
  assert.equal(part.availablePlants, 2000);

  const over = planMortalityToExcess({ slot, batch, plants: 9000 });
  assert.match(over.error, /8,900/);
  assert.equal(planMortalityToExcess({ slot, batch, plants: 0 }).error, "Enter how many plants to move");
});

test("a mongoose batch still has mortality to move", () => {
  const data = {
    plantsSowed: 103068,
    orderCoveredPlants: 88000,
    expectedMortalityApplied: 12400,
    excessAllocations: [{ plants: 20000 }, { plants: 6000 }],
  };
  const plan = planMortalityToExcess({
    slot: { actualPlants: 90000, expectedMortality: 12400, availablePlants: 2668, excessiveSowing: { plants: 0 } },
    batch: { toObject: () => ({ ...data }) },
    plants: 368,
  });
  assert.equal(plan.error, undefined);
  assert.equal(plan.mort, 368);
  assert.equal(plan.expectedMortality, 12032);
});

test("irrelevant and already-released batches are refused", () => {
  assert.equal(
    planMortalityToExcess({ slot: {}, batch: { isIrrelevant: true, expectedMortalityApplied: 50 } }).error,
    "Irrelevant sowing is not counted"
  );
  assert.equal(
    planMortalityToExcess({ slot: {}, batch: { noMortalityReserve: true, expectedMortalityApplied: 50 } }).error,
    "Mortality is already in excess"
  );
});
