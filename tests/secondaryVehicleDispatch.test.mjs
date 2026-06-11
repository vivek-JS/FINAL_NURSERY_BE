import { describe, it } from "node:test";
import assert from "node:assert";
import {
  normalizeInwardSelections,
  allocateManualSecondaryLoads,
  allocateSecondaryFifoPlants,
  DISPATCH_SHED_ALLOWED_STATUSES,
} from "../services/secondaryVehicleLoad.service.js";
import {
  normalizeOutwardUnloadSelections,
  assertDispatchShedOpsAllowed,
} from "../services/secondaryVehicleUnload.service.js";

describe("secondaryVehicleLoad — manual inward selections", () => {
  const suggestions = [
    {
      batchId: "b1",
      secondaryInwardId: "si1",
      batchNumber: "A-20",
      remainingPlants: 5000,
      availableQuantity: 5000,
      cavity: 126,
      numberPerCrate: 12,
      dispatchEligible: true,
      pollyhouse: "PH-1",
      size: "R1",
    },
    {
      batchId: "b2",
      secondaryInwardId: "si2",
      batchNumber: "A-22",
      remainingPlants: 3000,
      availableQuantity: 3000,
      cavity: 126,
      numberPerCrate: 12,
      dispatchEligible: true,
      pollyhouse: "PH-1",
      size: "R1",
    },
  ];

  it("normalizeInwardSelections aggregates duplicate inward ids", () => {
    const rows = normalizeInwardSelections([
      { secondaryInwardId: "si1", plants: 1000 },
      { secondaryInwardId: "si1", plants: 500 },
      { secondaryInwardId: "si2", plants: 2000 },
    ]);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows.find((r) => r.secondaryInwardId === "si1")?.plants, 1500);
    assert.strictEqual(rows.find((r) => r.secondaryInwardId === "si2")?.plants, 2000);
  });

  it("allocateManualSecondaryLoads splits 4000 across two inward lines", () => {
    const result = allocateManualSecondaryLoads(
      suggestions,
      [
        { secondaryInwardId: "si1", plants: 2000 },
        { secondaryInwardId: "si2", plants: 2000 },
      ],
      { capPlants: 4000 },
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.totalAllocated, 4000);
    assert.strictEqual(result.allocations.length, 2);
    assert.strictEqual(result.allocations[0].plants, 2000);
    assert.strictEqual(result.allocations[1].plants, 2000);
  });

  it("rejects selection above capPlants", () => {
    const result = allocateManualSecondaryLoads(
      suggestions,
      [{ secondaryInwardId: "si1", plants: 5000 }],
      { capPlants: 4000 },
    );
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /exceeds remaining need/i);
  });

  it("FIFO allocateSecondaryFifoPlants fills oldest lines first", () => {
    const fifo = allocateSecondaryFifoPlants(suggestions, 2500);
    assert.strictEqual(fifo.ok, true);
    assert.strictEqual(fifo.totalAllocated, 2500);
    assert.strictEqual(fifo.allocations[0].secondaryInwardId, "si1");
    assert.strictEqual(fifo.allocations[0].plants, 2500);
  });
});

describe("secondaryVehicleUnload — outward selections", () => {
  it("normalizeOutwardUnloadSelections dedupes by outward id", () => {
    const rows = normalizeOutwardUnloadSelections([
      { secondaryOutwardId: "so1", batchId: "b1", plants: 100 },
      { secondaryOutwardId: "so1", plants: 50 },
    ]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].plants, 150);
    assert.strictEqual(rows[0].batchId, "b1");
  });
});

describe("secondaryVehicleDispatch — transport status", () => {
  it("DISPATCH_SHED_ALLOWED_STATUSES includes LOADED", () => {
    assert.ok(DISPATCH_SHED_ALLOWED_STATUSES.includes("LOADED"));
    assert.ok(DISPATCH_SHED_ALLOWED_STATUSES.includes("PENDING"));
    assert.ok(DISPATCH_SHED_ALLOWED_STATUSES.includes("IN_TRANSIT"));
  });

  it("assertDispatchShedOpsAllowed accepts LOADED", () => {
    assert.doesNotThrow(() =>
      assertDispatchShedOpsAllowed({ transportStatus: "LOADED" }),
    );
  });

  it("assertDispatchShedOpsAllowed rejects DELIVERED", () => {
    assert.throws(
      () => assertDispatchShedOpsAllowed({ transportStatus: "DELIVERED" }),
      /PENDING, IN_TRANSIT, or LOADED/i,
    );
  });
});
