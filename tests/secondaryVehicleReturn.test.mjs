import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planVehicleReturn, sumShedReturns } from "../services/secondaryVehicleReturn.service.js";

const lines = [
  { batchId: "b1", secondaryOutwardId: "o1", linkedOrderId: "ord1", plants: 500, cavity: 50 },
  { batchId: "b1", secondaryOutwardId: "o2", linkedOrderId: "ord2", plants: 300, cavity: 50 },
  { batchId: "b2", secondaryOutwardId: "o3", linkedOrderId: "ord1", plants: 200, cavity: 50 },
];

describe("planVehicleReturn", () => {
  it("takes the order from the loaded line and caps at what was loaded", () => {
    const p = planVehicleReturn({ lines, priorReturns: [], batchId: "b1", sourceOutwardId: "o1", quantity: 120 });
    assert.equal(p.error, undefined);
    assert.equal(p.orderId, "ord1");
    assert.equal(p.maxReturnable, 500);
    assert.equal(p.sourceLine.secondaryOutwardId, "o1");
  });

  it("subtracts earlier returns of the same loaded line", () => {
    const prior = [{ batchId: "b1", sourceOutwardId: "o1", orderId: "ord1", quantity: 450 }];
    const ok = planVehicleReturn({ lines, priorReturns: prior, batchId: "b1", sourceOutwardId: "o1", quantity: 50 });
    assert.equal(ok.error, undefined);
    const tooMany = planVehicleReturn({ lines, priorReturns: prior, batchId: "b1", sourceOutwardId: "o1", quantity: 51 });
    assert.match(tooMany.error, /Only 50/);
  });

  it("rejects a batch that was not loaded and zero quantity", () => {
    assert.ok(planVehicleReturn({ lines, priorReturns: [], batchId: "b9", quantity: 5 }).error);
    assert.ok(planVehicleReturn({ lines, priorReturns: [], batchId: "b1", sourceOutwardId: "o1", quantity: 0 }).error);
  });

  it("without a line or order, caps across the whole batch", () => {
    const p = planVehicleReturn({ lines, priorReturns: [], batchId: "b1", quantity: 800 });
    assert.equal(p.error, undefined);
    assert.equal(p.orderId, null);
    assert.ok(planVehicleReturn({ lines, priorReturns: [], batchId: "b1", quantity: 801 }).error);
  });
});

describe("sumShedReturns", () => {
  it("filters by order", () => {
    const r = [
      { orderId: "ord1", quantity: 10 },
      { orderId: "ord2", quantity: 5 },
    ];
    assert.equal(sumShedReturns(r), 15);
    assert.equal(sumShedReturns(r, { orderId: "ord1" }), 10);
  });
});
