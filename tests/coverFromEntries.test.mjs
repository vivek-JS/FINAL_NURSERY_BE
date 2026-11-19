import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeEntryPicks,
  picksMatchNeed,
  planEntryTakes,
} from "../modules/sowingEntries/coverFromEntriesMath.js";

test("entry picks merge by sowing and drop empty rows", () => {
  const picks = normalizeEntryPicks([
    { entryId: "a", plants: 200 },
    { entryId: "a", plants: 50 },
    { plants: 10 },
    { entryId: "b", plants: 0 },
  ]);
  assert.deepEqual(picks, [
    { entryId: "a", plants: 250 },
  ]);
});

test("a pick takes free excess and leaves plants already on the order", () => {
  const takes = planEntryTakes(
    [{ entryId: "e1", plants: 800 }],
    [{ entryId: "e1", requestNumber: "SR1", freePlants: 1000, excessPlants: 600 }]
  );
  assert.equal(takes[0].fromExcess, 600);
  assert.equal(takes[0].plants, 800);
  assert.equal(picksMatchNeed(takes, 800), true);
});

test("a pick above the free plants is refused", () => {
  assert.throws(
    () =>
      planEntryTakes([{ entryId: "e1", plants: 500 }], [
        { entryId: "e1", requestNumber: "SR1", freePlants: 200, excessPlants: 200 },
      ]),
    (err) => err.code === "INSUFFICIENT_ENTRY_EXCESS"
  );
});
