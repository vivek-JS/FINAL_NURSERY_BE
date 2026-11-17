import test from "node:test";
import assert from "node:assert/strict";
import moment from "moment";
import { rowsFromEntries } from "../modules/sowingEntries/boardExcessFromEntries.js";
import { IST_OFFSET } from "../utility/istSlotDate.js";

const today = moment("2026-11-01", "YYYY-MM-DD").utcOffset(IST_OFFSET, true).startOf("day");

function entry(ready, excess, extra = {}) {
  return {
    plantId: "plant-1",
    subtypeId: "sub-1",
    plantReadyDate: ready,
    plantsSowed: excess,
    orderCoveredPlants: 0,
    bufferPlants: 0,
    sowingBufferPct: 0,
    excessPlants: excess,
    ...extra,
  };
}

test("ready today or earlier is Now, a later ready day stays on that day", () => {
  const rows = rowsFromEntries(
    [entry("01-11-2026", 100), entry("20-10-2026", 40), entry("17-11-2026", 285)],
    { today, groupDays: 1 }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].now, 140);
  assert.equal(rows[0].cells.length, 1);
  assert.equal(rows[0].cells[0].startDay, "17-11-2026");
  assert.equal(rows[0].cells[0].excess, 285);
  assert.equal(rows[0].total, 425);
});

test("sowing older than the board lookback is left out", () => {
  const rows = rowsFromEntries([entry("01-09-2026", 5000), entry("17-11-2026", 10)], { today });
  assert.equal(rows[0].now, 0);
  assert.equal(rows[0].total, 10);
});

test("a blank mortality stamp still uses the stored CMS percent", () => {
  const rows = rowsFromEntries(
    [
      {
        plantId: "plant-1",
        subtypeId: "sub-1",
        plantReadyDate: "17-11-2026",
        plantsSowed: 26460,
        orderCoveredPlants: 23000,
        sowingBufferPct: 12,
        bufferPlants: 0,
        excessPlants: 3460,
      },
    ],
    { today }
  );
  assert.equal(rows[0].cells[0].excess, 285);
});
