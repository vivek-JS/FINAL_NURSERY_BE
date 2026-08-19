import { describe, it } from "node:test";
import assert from "node:assert";
import { computeSlotPhysicalMetrics } from "../utility/pastDueSlotMetrics.js";

describe("computeSlotPhysicalMetrics", () => {
  it("computes gap and surplus vs actualPlants", () => {
    const slot = { actualPlants: 800, rolledInAvailablePlants: 100 };
    const dispatchStats = {
      remainingNative: 500,
      remainingRolledIn: 400,
      remainingToDispatch: 900,
    };
    const m = computeSlotPhysicalMetrics(slot, dispatchStats);
    assert.strictEqual(m.actualRemainingPlants, 900);
    assert.strictEqual(m.actualGapPlants, 100);
    assert.strictEqual(m.actualGapPct, 13);
    assert.strictEqual(m.actualSurplusPlants, 0);
    assert.strictEqual(m.actualAvailable, 800);
    assert.strictEqual(m.rolledInAvailablePlants, 100);
  });

  it("reports surplus when actual exceeds queue", () => {
    const m = computeSlotPhysicalMetrics(
      { actualPlants: 1200 },
      { remainingNative: 400, remainingRolledIn: 0, remainingToDispatch: 400 }
    );
    assert.strictEqual(m.actualGapPlants, 0);
    assert.strictEqual(m.actualSurplusPlants, 800);
    assert.strictEqual(m.actualAvailable, 1200);
  });

  it("actualAvailable is actual minus dispatched even when queue is larger", () => {
    const m = computeSlotPhysicalMetrics(
      { actualPlants: 800 },
      {
        remainingNative: 900,
        remainingRolledIn: 0,
        remainingToDispatch: 900,
        totalDispatchedPlants: 150,
        totalAllDispatchedPlants: 150,
      }
    );
    assert.strictEqual(m.actualAvailable, 650);
    assert.strictEqual(m.actualGapPlants, 100);
  });
});
