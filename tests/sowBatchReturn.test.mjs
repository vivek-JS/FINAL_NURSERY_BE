import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applySowReturnToBatch } from "../services/sowBatchReturn.service.js";

describe("applySowReturnToBatch", () => {
  it("puts plants back as excess and unbooks the order", () => {
    const slot = { availablePlants: 0, excessiveSowing: { plants: 0 } };
    const batch = {
      plantsSowed: 1050,
      orderCoveredPlants: 1000,
      excessPlants: 50,
      shownExcess: 50,
      sowingBufferPct: 0,
      shedName: "Shed A",
      linkedOrderIds: ["ord1"],
      excessAllocations: [{ orderId: "ord1", plants: 200 }],
      dispatchLog: [],
      changeLog: [],
    };
    const r = applySowReturnToBatch({
      batch,
      slot,
      qty: 200,
      orderId: "ord1",
      destShed: "Shed B",
      dispatchId: "d1",
      reason: "Damaged",
    });
    assert.equal(r.restored, 200);
    assert.equal(r.unbooked, 200);
    assert.equal(slot.availablePlants, 200);
    assert.equal(slot.excessiveSowing.plants, 200);
    assert.equal(batch.orderCoveredPlants, 800);
    assert.equal(batch.excessPlants, 250);
    assert.equal(batch.shedName, "Shed B");
    assert.equal(batch.excessAllocations.length, 0);
    assert.equal(batch.shownExcess, 250);
    assert.equal(batch.dispatchLog[0].bucket, "RETURN");
    assert.equal(batch.dispatchLog[0].plants, -200);
    assert.match(batch.dispatchLog[0].reason, /Return from order/);
    assert.match(batch.dispatchLog[0].reason, /Damaged/);
    assert.equal(batch.changeLog?.length, 1);
    assert.equal(batch.changeLog[0].kind, "RETURN");
    assert.equal(batch.changeLog[0].plants, 200);
    assert.equal(batch.changeLog[0].coverBefore, 1000);
    assert.equal(batch.changeLog[0].coverAfter, 800);
    assert.equal(batch.changeLog[0].excessAfter, 250);
    assert.match(batch.changeLog[0].reason, /Return from order · Damaged/);
  });

  it("drops the order link when cover and allocs are gone", () => {
    const slot = { availablePlants: 10, excessiveSowing: { plants: 0 } };
    const batch = {
      orderCoveredPlants: 80,
      excessPlants: 0,
      linkedOrderIds: ["ord1"],
      excessAllocations: [{ orderId: "ord1", plants: 80 }],
      dispatchLog: [],
    };
    applySowReturnToBatch({ batch, slot, qty: 80, orderId: "ord1", destShed: "Shed A" });
    assert.equal(batch.orderCoveredPlants, 0);
    assert.deepEqual(batch.linkedOrderIds, []);
  });
});
