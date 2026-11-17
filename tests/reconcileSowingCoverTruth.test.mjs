import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planCoverTruth } from "../utility/reconcileSowingCoverTruth.js";

describe("planCoverTruth", () => {
  it("stamps cover from sources only and marks done when full", () => {
    const rid = "req1";
    const batch = {
      plantsSowed: 10000,
      orderCoveredPlants: 5000,
      sowingBufferPct: 12,
      mortalityMovedToExcess: 0,
      linkedOrderIds: [],
      excessAllocations: [{ orderId: "o1", plants: 9999 }],
    };
    const orders = [
      {
        _id: "o1",
        orderId: 1,
        numberOfPlants: 8000,
        sowingDone: false,
        leftoverFromIncomplete: true,
        sowingCoverSources: [{ sowingRequestId: rid, requestNumber: "SR1", plants: 8000 }],
      },
    ];
    const plan = planCoverTruth({
      requestId: rid,
      requestNumber: "SR1",
      batch,
      orders,
      sowingBufferPct: 12,
    });
    assert.equal(plan.attributed, 8000);
    assert.equal(plan.stamped, 5000);
    assert.equal(plan.linkedOrderIds.length, 1);
    assert.equal(plan.excessAllocations[0].plants, 8000);
    assert.equal(plan.orderFixes.length, 1);
    assert.equal(plan.orderFixes[0].sowingDone, true);
    // saleable = 10000 - 1200 = 8800; cover 8000 → moved 0
    assert.equal(plan.mortalityMovedToExcess, 0);
  });

  it("raises mortalityMoved when sources exceed saleable", () => {
    const rid = "req1";
    const batch = {
      plantsSowed: 10584,
      orderCoveredPlants: 0,
      sowingBufferPct: 12,
      linkedOrderIds: [],
      excessAllocations: [],
    };
    const orders = [
      {
        _id: "o1",
        orderId: 4338,
        numberOfPlants: 12000,
        sowingDone: true,
        sowingCoverSources: [{ sowingRequestId: rid, requestNumber: "SR7", plants: 10584 }],
      },
    ];
    const plan = planCoverTruth({
      requestId: rid,
      requestNumber: "SR7",
      batch,
      orders,
    });
    assert.equal(plan.attributed, 10584);
    // saleable 9314 → need moved 1270
    assert.equal(plan.mortalityMovedToExcess, 1270);
    assert.equal(plan.shownExcess, 0);
    assert.equal(plan.orderFixes[0].sowingDone, false); // 10584 < 12000
  });

  it("promotes alloc into sources when sources missing", () => {
    const batch = {
      plantsSowed: 5000,
      orderCoveredPlants: 5000,
      sowingBufferPct: 0,
      excessAllocations: [{ orderId: "o1", plants: 5000 }],
      linkedOrderIds: ["o1"],
    };
    const orders = [
      {
        _id: "o1",
        orderId: 1,
        numberOfPlants: 5000,
        sowingDone: false,
        sowingDoneRequestId: "req1",
        sowingCoverSources: [],
      },
    ];
    const plan = planCoverTruth({
      requestId: "req1",
      requestNumber: "SR1",
      batch,
      orders,
    });
    assert.equal(plan.attributed, 5000);
    assert.equal(plan.sourcePromotes.length, 1);
    assert.equal(plan.sourcePromotes[0].plants, 5000);
    assert.equal(plan.orderFixes[0].sowingDone, true);
  });
});
