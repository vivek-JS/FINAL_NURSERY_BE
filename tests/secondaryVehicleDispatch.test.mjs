import { describe, it } from "node:test";
import assert from "node:assert";
import {
  normalizeInwardSelections,
  allocateManualSecondaryLoads,
  allocateSecondaryFifoPlants,
  DISPATCH_SHED_ALLOWED_STATUSES,
  vehicleLineRemainingMap,
  takePlantsFromOrdersFifo,
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

describe("secondaryVehicleLoad — split one plant row across orders", () => {
  const dispatchDoc = {
    orderDispatchDetails: [
      { orderId: "o1", dispatchQuantity: 2001, shedLoadedQuantity: 0 },
      { orderId: "o2", dispatchQuantity: 500, shedLoadedQuantity: 100 },
    ],
  };

  it("vehicleLineRemainingMap reads remaining per order line", () => {
    const rem = vehicleLineRemainingMap(dispatchDoc, ["o1", "o2", "o3"]);
    assert.strictEqual(rem.get("o1"), 2001);
    assert.strictEqual(rem.get("o2"), 400);
    assert.strictEqual(rem.get("o3"), 0);
  });

  it("fills oldest order first and carries the remainder across allocations", () => {
    const rem = vehicleLineRemainingMap(dispatchDoc, ["o1", "o2"]);
    const a = takePlantsFromOrdersFifo(1977, ["o1", "o2"], rem);
    assert.deepStrictEqual(a.allocations, [{ orderId: "o1", plants: 1977 }]);
    assert.strictEqual(a.unassigned, 0);
    const b = takePlantsFromOrdersFifo(200, ["o1", "o2"], rem);
    assert.deepStrictEqual(b.allocations, [
      { orderId: "o1", plants: 24 },
      { orderId: "o2", plants: 176 },
    ]);
    assert.strictEqual(rem.get("o1"), 0);
    assert.strictEqual(rem.get("o2"), 224);
  });

  it("reports plants beyond all order lines as unassigned", () => {
    const rem = vehicleLineRemainingMap(dispatchDoc, ["o2"]);
    const r = takePlantsFromOrdersFifo(450, ["o2"], rem);
    assert.strictEqual(r.unassigned, 50);
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
