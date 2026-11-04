import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addCalendarDays,
  applySend,
  applySow,
  mortalityExpectedPlants,
  parseDay,
  plantsNotSent,
  stockBySize,
  takeBottles,
  traySplit,
} from "../utility/primaryLedgerMath.js";

describe("primary ledger math", () => {
  it("splits 1000 bottles into 33 trays and an incomplete tray of 10", () => {
    assert.deepEqual(traySplit(1000), {
      bottles: 1000,
      completeTrays: 33,
      incompleteBottles: 10,
    });
  });

  it("does not round a full set of trays up", () => {
    assert.deepEqual(traySplit(990), {
      bottles: 990,
      completeTrays: 33,
      incompleteBottles: 0,
    });
  });

  it("keeps expected plants and mortality expected plants", () => {
    assert.equal(mortalityExpectedPlants(10000), 9000);
    assert.equal(plantsNotSent(9000, 4000), 5000);
    assert.equal(plantsNotSent(9000, 9000), 0);
  });

  it("adds ready days on the calendar", () => {
    const ready = addCalendarDays(parseDay("2026-11-10"), 21);
    assert.equal(ready.toISOString().slice(0, 10), "2026-12-01");
  });

  it("spending 20 bottles from 33 full trays leaves an incomplete tray of 10", () => {
    const taken = takeBottles(
      [{ bottlesLeft: 990, size: "R1" }],
      20,
      "R1"
    );
    assert.equal(taken.size, "R1");
    assert.equal(taken.receipts[0].bottlesLeft, 970);
    assert.deepEqual(traySplit(970), {
      bottles: 970,
      completeTrays: 32,
      incompleteBottles: 10,
    });
  });

  it("refuses to spend more bottles than are on hand", () => {
    assert.equal(takeBottles([{ bottlesLeft: 10, size: "R1" }], 11, "R1"), null);
  });

  it("does not spend R2 bottles when sowing R1", () => {
    const taken = takeBottles(
      [
        { bottles: 10, bottlesLeft: 10, size: "R1" },
        { bottles: 30, bottlesLeft: 30, size: "R2" },
      ],
      10,
      "R1"
    );
    assert.equal(taken.receipts[0].bottlesLeft, 0);
    assert.equal(taken.receipts[1].bottlesLeft, 30);
    assert.equal(takeBottles([{ bottlesLeft: 30, size: "R2" }], 10, "R1"), null);
    const rows = stockBySize(
      [
        { bottles: 10, bottlesLeft: 0, size: "R1" },
        { bottles: 30, bottlesLeft: 30, size: "R2" },
      ],
      [{ size: "R1", expectedPlants: 10000, mortalityExpectedPlants: 9000, plantsSent: 0 }]
    );
    assert.deepEqual(
      rows.map((row) => row.size),
      ["R1", "R2"]
    );
    assert.equal(rows[1].bottlesLeft, 30);
    assert.equal(rows[0].plantsNotSent, 9000);
  });

  it("defaults a missing size to R1 and lets R2 be added later", () => {
    const ledger = {
      receipts: [
        { bottles: 1000, bottlesLeft: 1000, size: "R1" },
        { bottles: 30, bottlesLeft: 30, size: "R2" },
      ],
      bottlesLeft: 1030,
      bottlesSown: 0,
      expectedPlants: 0,
      mortalityExpectedPlants: 0,
    };
    const first = applySow(ledger, {
      bottles: 10,
      expectedPlants: 10000,
      sowDate: "2026-11-10",
      readyDays: 21,
    });
    assert.equal(first.error, undefined);
    assert.equal(first.sow.size, "R1");
    assert.equal(first.sow.mortalityExpectedPlants, 9000);
    assert.equal(first.sow.readyDate.toISOString().slice(0, 10), "2026-12-01");
    assert.equal(first.bottlesLeft, 1020);
    assert.equal(first.receipts[0].bottlesLeft, 990);
    assert.equal(first.receipts[1].bottlesLeft, 30);

    const sent = applySend(first.sow, 4000);
    assert.equal(sent.plantsSent, 4000);
    assert.equal(sent.plantsNotSent, 5000);
    assert.equal(sent.bottlesUnchanged, true);

    const second = applySow(
      { ...first, receipts: first.receipts },
      { bottles: 20, expectedPlants: 2000, size: "R2", sowDate: "2026-11-12", readyDays: 21 }
    );
    assert.equal(second.sow.size, "R2");
    assert.equal(second.receipts[0].bottlesLeft, 990);
    assert.equal(second.receipts[1].bottlesLeft, 10);
    assert.equal(applySow(first, { bottles: 40, expectedPlants: 1, size: "R2" }).error, "Not enough R2 bottles on hand");
    assert.equal(applySow(ledger, { bottles: 1, expectedPlants: 1, size: "R4" }).error, "Choose R1, R2, or R3");
  });
});