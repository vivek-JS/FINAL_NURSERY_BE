import assert from "node:assert/strict";
import test from "node:test";
import { sowingEntriesSortSpec } from "../modules/sowingEntries/listSowingEntries.controller.js";

test("default sort is newest sow, then request number", () => {
  assert.deepEqual(sowingEntriesSortSpec("", ""), {
    sowDay: -1,
    requestNumber: -1,
    _id: -1,
  });
});

test("plant and sowing id sort on their own columns", () => {
  assert.equal(sowingEntriesSortSpec("plant", "asc").plantName, 1);
  assert.equal(sowingEntriesSortSpec("plant", "asc").subtypeName, 1);
  assert.equal(sowingEntriesSortSpec("sowingId", "desc").requestNumber, -1);
});

test("number columns use the figure the table shows", () => {
  assert.equal(sowingEntriesSortSpec("expectedReady", "desc").expectedReady, -1);
  assert.equal(sowingEntriesSortSpec("cover", "asc").coverSort, 1);
  assert.equal(sowingEntriesSortSpec("excess", "desc").excessSort, -1);
  assert.equal(sowingEntriesSortSpec("mortality", "asc").mortalitySort, 1);
  assert.equal(sowingEntriesSortSpec("readyDate", "asc").readySort, 1);
  assert.equal(sowingEntriesSortSpec("sowed", "desc").plantsSowed, -1);
  assert.equal(sowingEntriesSortSpec("out", "desc").dispatchedPlants, -1);
  assert.equal(sowingEntriesSortSpec("remaining", "desc").remainingSort, -1);
});
