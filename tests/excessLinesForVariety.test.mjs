import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { entryCountsOnBoard, excessLineFromEntry } from "../modules/sowingEntries/excessLinesForVariety.js";

describe("excess lines for a variety", () => {
  it("keeps ready dates inside the board lookback and drops older ones", () => {
    assert.equal(entryCountsOnBoard("14-10-2026", "2026-11-03"), true);
    assert.equal(entryCountsOnBoard("10-11-2026", "2026-11-03"), true);
    assert.equal(entryCountsOnBoard("01-09-2026", "2026-11-03"), false);
    assert.equal(entryCountsOnBoard("", "2026-11-03"), true);
  });

  it("uses bookable excess, not a stored stamp", () => {
    const line = excessLineFromEntry({
      _id: "e1",
      requestNumber: "SR1",
      sowDay: "2026-10-01",
      plantReadyDate: "14-10-2026",
      plantsSowed: 1000,
      orderCoveredPlants: 100,
      sowingBufferPct: 10,
      isIrrelevant: false,
    });
    assert.equal(line.excessPlants, 800);
    assert.equal(line.plantsSowed, 1000);
    assert.equal(line.requestNumber, "SR1");
    assert.equal(line.plantReadyDate, "14-10-2026");
    assert.equal(excessLineFromEntry({ isIrrelevant: true, plantsSowed: 100 }), null);
  });
});
