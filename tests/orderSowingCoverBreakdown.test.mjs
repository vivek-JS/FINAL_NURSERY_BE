import test from "node:test";
import assert from "node:assert/strict";
import { buildOrderSowingCoverBreakdown } from "../utility/orderSowingCoverBreakdown.js";

test("caps sownHere at order and reports remaining", () => {
  const b = buildOrderSowingCoverBreakdown({
    orderPlants: 8000,
    fromThisRaw: 7244,
    fromOthers: 0,
    sowingDone: false,
  });
  assert.equal(b.orderPlants, 8000);
  assert.equal(b.sownHere, 7244);
  assert.equal(b.remaining, 756);
  assert.equal(b.stillNeed, 756);
  assert.equal(b.coverStatus, "partial");
});

test("over-alloc on this sow still shows order size as sownHere", () => {
  const b = buildOrderSowingCoverBreakdown({
    orderPlants: 8000,
    fromThisRaw: 8489,
    sowingDone: true,
  });
  assert.equal(b.sownHere, 8000);
  assert.equal(b.remaining, 0);
  assert.equal(b.stillNeed, 0);
  assert.equal(b.coverStatus, "done");
});

test("Also fills remaining → Covered + Remaining 0", () => {
  const b = buildOrderSowingCoverBreakdown({
    orderPlants: 15000,
    fromThisRaw: 12660,
    fromOthers: 2340,
    otherCoverSources: [{ requestNumber: "SR202610240004", plants: 2340 }],
  });
  assert.equal(b.sownHere, 12660);
  assert.equal(b.remaining, 0);
  assert.equal(b.stillNeed, 0);
  assert.equal(b.coverStatus, "done");
  assert.equal(b.otherCoverSources.length, 1);
});

test("sowingDone with zero plants on this sow is need, not covered", () => {
  const b = buildOrderSowingCoverBreakdown({
    orderPlants: 37000,
    fromThisRaw: 0,
    fromOthers: 0,
    sowingDone: true,
  });
  assert.equal(b.sownHere, 0);
  assert.equal(b.remaining, 37000);
  assert.equal(b.stillNeed, 37000);
  assert.equal(b.coverStatus, "need");
  assert.equal(b.orderSowingDone, true);
  assert.equal(b.sowingDone, false);
});
