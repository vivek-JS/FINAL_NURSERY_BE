import test from "node:test";
import assert from "node:assert/strict";
import { excessFieldsForBatch } from "../utility/sowingBatchExcessStamp.js";
import { toSowingEntryListItem } from "../modules/sowingEntries/mapSowingEntry.js";
import {
  pickNextSowing,
  restamp,
  withMarked,
  withSowed,
} from "../modules/sowingEntries/leftoverSowingMath.js";

const source = {
  _id: "source",
  plantsSowed: 1000,
  bufferPlants: 100,
  sowingBufferPct: 10,
  orderCoveredPlants: 400,
  dispatchedPlants: 400,
  noMortalityReserve: false,
  plantReadyDate: "01-11-2026",
  sowDay: "2026-10-01",
};

test("transfer keeps the mortality count and moves leftover onto the next sowing", () => {
  const before = restamp(source);
  assert.equal(before.remainingPlants, 500);
  assert.equal(before.excessPlants, 500);

  const after = withSowed(source, source.plantsSowed - 500);
  assert.equal(after.plantsSowed, 500);
  assert.equal(after.bufferPlants, 100);
  assert.equal(after.remainingPlants, 0);
  assert.equal(after.excessPlants, 0);

  const target = withSowed(
    {
      plantsSowed: 2000,
      bufferPlants: 200,
      sowingBufferPct: 10,
      orderCoveredPlants: 0,
      dispatchedPlants: 0,
    },
    2500
  );
  assert.equal(target.bufferPlants, 200);
  assert.equal(target.excessPlants, 2300);
  assert.equal(target.remainingPlants, 2300);
});

test("a buffer that no longer fits is kept only up to the plants still sown", () => {
  const shrunk = withSowed(
    { plantsSowed: 80, bufferPlants: 50, sowingBufferPct: 62.5, dispatchedPlants: 0, orderCoveredPlants: 0 },
    30
  );
  assert.equal(shrunk.plantsSowed, 30);
  assert.equal(shrunk.bufferPlants, 30);
  assert.equal(shrunk.remainingPlants, 0);
});

test("mark sellable adds bookable excess and does not grow mortality or change remaining", () => {
  const covered = {
    plantsSowed: 1000,
    bufferPlants: 100,
    sowingBufferPct: 10,
    orderCoveredPlants: 900,
    dispatchedPlants: 400,
  };
  const before = restamp(covered);
  assert.equal(before.excessPlants, 0);
  assert.equal(before.remainingPlants, 500);
  const after = withMarked(covered, 100);
  assert.equal(after.plantsSowed, 1000);
  assert.equal(after.bufferPlants, 100);
  assert.equal(after.remainingPlants, 500);
  assert.equal(after.plantsMarkedSellable, 100);
  assert.equal(after.excessPlants, 100);
  assert.equal(
    excessFieldsForBatch(after, after.sowingBufferPct).shownExcess,
    100
  );
});

test("next sowing is the soonest ready date after this one", () => {
  const rows = [
    { _id: "later", plantReadyDate: "20-12-2026", sowDay: "2026-11-01", isIrrelevant: false },
    { _id: "old", plantReadyDate: "01-10-2026", sowDay: "2026-09-01", isIrrelevant: false },
    { _id: "soon", plantReadyDate: "15-11-2026", sowDay: "2026-10-20", isIrrelevant: false },
    { _id: "sooner-later-sow", plantReadyDate: "15-11-2026", sowDay: "2026-10-28", isIrrelevant: false },
    { _id: "marked", plantReadyDate: "10-11-2026", sowDay: "2026-10-15", isIrrelevant: true },
  ];
  const next = pickNextSowing(source, rows);
  assert.equal(next._id, "soon");
  assert.equal(pickNextSowing({ ...source, plantReadyDate: "" }, rows), null);
});

test("the sowing list returns the transfer log and drops destroyed plants from sowed", () => {
  const item = toSowingEntryListItem({
    _id: "abc",
    plantsSowed: 1000,
    destroyedPlants: 100,
    bufferPlants: 100,
    sowingBufferPct: 10,
    orderCoveredPlants: 0,
    plantsTransferredOut: 500,
    transferLog: [{ plants: 500, direction: "out", otherRequestNumber: "SR9", otherEntryId: "def" }],
  });
  assert.equal(item.sowedQuantity, 900);
  assert.equal(item.plantsTransferredOut, 500);
  assert.equal(item.latestTransfer.otherRequestNumber, "SR9");
  assert.equal(item.latestTransfer.direction, "out");
  assert.equal(item.affectedSlot.batchDestroyedPlants, 100);
});
