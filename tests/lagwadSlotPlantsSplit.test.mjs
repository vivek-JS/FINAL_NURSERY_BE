import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitLagwadQtyForSlot,
  computeLagwadPendingSlotSync,
  sowQtySlotImpact,
} from "../utility/lagwadSlotPlantsSplit.js";

describe("lagwad 90/10 split", () => {
  it("splits 166488 lagwad sample lines", () => {
    const lines = [42992, 41280, 41168, 41048];
    let actual = 0;
    let mortality = 0;
    for (const q of lines) {
      const s = splitLagwadQtyForSlot(q);
      actual += s.actualPlants;
      mortality += s.expectedMortality;
      assert.equal(s.actualPlants + s.expectedMortality, q);
    }
    assert.equal(actual + mortality, 166488);
    assert.equal(actual, 149838);
    assert.equal(mortality, 16650);
  });

  it("pending sync uses 90% cap", () => {
    const r = computeLagwadPendingSlotSync(100, 0);
    assert.equal(r.pending, 90);
    assert.equal(r.maxSynced, 90);
    assert.equal(r.syncedAfter, 90);
  });

  it("order mark-sow: 90% actual + 10% mortality, reserved = 90% of covered", () => {
    const r = sowQtySlotImpact(1000, { orderCoveredPlants: 1000, excessPlants: 0 });
    assert.equal(r.plantsSowed, 1000);
    assert.equal(r.actualPlants, 900);
    assert.equal(r.expectedMortality, 100);
    assert.equal(r.availablePlants, 0);
    assert.equal(r.orderReservedPlants, 900);
  });

  it("excess-only sow: saleable available = 90% actual", () => {
    const r = sowQtySlotImpact(1000, { isExcess: true });
    assert.equal(r.actualPlants, 900);
    assert.equal(r.expectedMortality, 100);
    assert.equal(r.availablePlants, 900);
    assert.equal(r.orderReservedPlants, 0);
  });

  it("mixed cover + leftover: reserved + available = actual", () => {
    const r = sowQtySlotImpact(11000, {
      orderCoveredPlants: 10000,
      excessPlants: 1000,
    });
    assert.equal(r.actualPlants, 9900);
    assert.equal(r.expectedMortality, 1100);
    assert.equal(r.availablePlants + r.orderReservedPlants, r.actualPlants);
  });
});
