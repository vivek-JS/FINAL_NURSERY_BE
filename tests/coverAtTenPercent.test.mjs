import test from "node:test";
import assert from "node:assert/strict";
import { coverAtTenPercent } from "../utility/coverAtTenPercent.js";

test("10% pool covers every order when it fits", () => {
  const plan = coverAtTenPercent(70056, [16000, 20000, 9000, 17000]);
  assert.equal(plan.covered, 62000);
  assert.equal(plan.mortalityLeft, 7006);
  assert.equal(plan.excess, 1050);
  assert.deepEqual(plan.taken, [16000, 20000, 9000, 17000]);
});

test("10% remaining finishes a short order, otherwise the order stays partial", () => {
  const finished = coverAtTenPercent(4410, [4400]);
  assert.equal(finished.covered, 4400);
  assert.equal(finished.mortalityLeft, 10);
  assert.equal(finished.excess, 0);

  const stillShort = coverAtTenPercent(10000, [10500]);
  assert.equal(stillShort.pool, 9000);
  assert.equal(stillShort.covered, 9000);
  assert.equal(stillShort.taken[0], 9000);
  assert.equal(stillShort.mortalityLeft, 1000);
});
