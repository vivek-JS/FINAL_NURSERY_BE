import test from "node:test";
import assert from "node:assert/strict";
import { planSowBatchDestroy, sowBatchLeft } from "../services/sowBatchDestroy.service.js";

const slot = {
  totalPlants: 10000,
  primarySowed: 10000,
  plantsSowed: 10000,
  actualPlants: 9000,
  expectedMortality: 1000,
  availablePlants: 2000,
  orderReservedPlants: 7000,
  excessiveSowing: { plants: 2000 },
};

test("sowBatchLeft: sowed minus destroyed", () => {
  assert.equal(sowBatchLeft({ plantsSowed: 500, destroyedPlants: 120 }), 380);
  assert.equal(sowBatchLeft({ plantsSowed: 100, destroyedPlants: 300 }), 0);
});

test("planSowBatchDestroy: lowers sowed, survivors and free stock", () => {
  const plan = planSowBatchDestroy({
    slot,
    batches: [{ _id: "b1", plantsSowed: 5000, sowedAt: new Date(1) }],
    quantity: 1500,
  });
  assert.equal(plan.primarySowed, 8500);
  assert.equal(plan.plantsSowed, 8500);
  assert.equal(plan.totalPlants, 8500);
  assert.equal(plan.actualPlants, 7500);
  assert.equal(plan.expectedMortality, 1000);
  assert.equal(plan.orderReservedPlants, 7000);
  assert.equal(plan.availablePlants, 500);
  assert.equal(plan.excessivePlants, 500);
  assert.deepEqual(plan.takes, [{ batchId: "b1", plants: 1500 }]);
});

test("planSowBatchDestroy: free stock floors at zero when destroying reserved plants", () => {
  const plan = planSowBatchDestroy({
    slot,
    batches: [{ _id: "b1", plantsSowed: 5000 }],
    quantity: 3000,
  });
  assert.equal(plan.availablePlants, 0);
  assert.equal(plan.excessivePlants, 0);
  assert.equal(plan.primarySowed, 7000);
  assert.equal(plan.totalPlants, 7000);
  assert.equal(plan.actualPlants, 6000);
  assert.equal(plan.expectedMortality, 1000);
  assert.equal(plan.orderReservedPlants, 6000);
});

test("planSowBatchDestroy: mortality reserve drops only after live actual plants are gone", () => {
  const plan = planSowBatchDestroy({
    slot: {
      totalPlants: 1000,
      primarySowed: 1000,
      plantsSowed: 1000,
      actualPlants: 900,
      expectedMortality: 100,
      availablePlants: 0,
      orderReservedPlants: 900,
      excessiveSowing: { plants: 0 },
    },
    batches: [{ _id: "b1", plantsSowed: 1000 }],
    quantity: 950,
  });
  assert.equal(plan.totalPlants, 50);
  assert.equal(plan.primarySowed, 50);
  assert.equal(plan.actualPlants, 0);
  assert.equal(plan.expectedMortality, 50);
  assert.equal(plan.orderReservedPlants, 0);
});

test("planSowBatchDestroy: newest batch first, capped by what is left", () => {
  const batches = [
    { _id: "old", plantsSowed: 1000, destroyedPlants: 200, sowedAt: new Date(1) },
    { _id: "new", plantsSowed: 300, sowedAt: new Date(2) },
  ];
  const plan = planSowBatchDestroy({ slot, batches, quantity: 500 });
  assert.deepEqual(plan.takes, [
    { batchId: "new", plants: 300 },
    { batchId: "old", plants: 200 },
  ]);
  assert.match(planSowBatchDestroy({ slot, batches, quantity: 1200 }).error, /Only 1100/);
  assert.match(planSowBatchDestroy({ slot, batches, quantity: 0 }).error, /at least 1/);
});
