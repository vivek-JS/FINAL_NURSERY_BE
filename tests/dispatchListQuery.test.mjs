import test from "node:test";
import assert from "node:assert/strict";
import {
  DISPATCH_LEDGER_CUTOVER,
  buildDispatchCreatedAtFilter,
  constrainDispatchIds,
} from "../utility/dispatchListQuery.js";

test("buildDispatchCreatedAtFilter — inclusive IST day range", () => {
  const filter = buildDispatchCreatedAtFilter({ startDate: "2026-06-13", endDate: "2026-06-13" });
  assert.ok(filter);
  assert.ok(filter.$gte instanceof Date);
  assert.ok(filter.$lte instanceof Date);
  assert.ok(filter.$lte.getTime() > filter.$gte.getTime());
});

test("buildDispatchCreatedAtFilter — empty when no dates", () => {
  assert.equal(buildDispatchCreatedAtFilter({}), null);
  assert.equal(buildDispatchCreatedAtFilter({ ledger: "nope" }), null);
});

test("ledger=old is everything created before the cutover", () => {
  const filter = buildDispatchCreatedAtFilter({ ledger: "old" });
  assert.equal(filter.$lt.getTime(), DISPATCH_LEDGER_CUTOVER.getTime());
  assert.equal(filter.$gte, undefined);
  assert.equal(filter.$lte, undefined);
});

test("ledger=new starts at the cutover", () => {
  const filter = buildDispatchCreatedAtFilter({ ledger: "new" });
  assert.equal(filter.$gte.getTime(), DISPATCH_LEDGER_CUTOVER.getTime());
  assert.equal(filter.$lt, undefined);
});

test("ledger=new raises a start date that is before the cutover", () => {
  const filter = buildDispatchCreatedAtFilter({
    ledger: "new",
    startDate: "2020-01-01",
    endDate: "2026-11-09",
  });
  assert.equal(filter.$gte.getTime(), DISPATCH_LEDGER_CUTOVER.getTime());
  assert.ok(filter.$lte instanceof Date);
  assert.equal(filter.$lt, undefined);
});

test("ledger=old keeps a date range that already ends before the cutover", () => {
  const filter = buildDispatchCreatedAtFilter({
    ledger: "old",
    startDate: "2026-01-01",
    endDate: "2026-01-02",
  });
  assert.ok(filter.$gte instanceof Date);
  assert.ok(filter.$lte instanceof Date);
  assert.ok(filter.$lte < DISPATCH_LEDGER_CUTOVER);
  assert.equal(filter.$lt, undefined);
});

test("constrainDispatchIds keeps search ids and drops completed trips", () => {
  const filter = { isDeleted: false, _id: { $in: ["a", "b"] } };
  constrainDispatchIds(filter, { $nin: ["b"] });
  assert.equal(filter._id, undefined);
  assert.deepEqual(filter.$and, [{ _id: { $in: ["a", "b"] } }, { _id: { $nin: ["b"] } }]);
});
