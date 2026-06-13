import test from "node:test";
import assert from "node:assert/strict";
import { buildDispatchCreatedAtFilter } from "../utility/dispatchListQuery.js";

test("buildDispatchCreatedAtFilter — inclusive IST day range", () => {
  const filter = buildDispatchCreatedAtFilter({ startDate: "2026-06-13", endDate: "2026-06-13" });
  assert.ok(filter);
  assert.ok(filter.$gte instanceof Date);
  assert.ok(filter.$lte instanceof Date);
  assert.ok(filter.$lte.getTime() > filter.$gte.getTime());
});

test("buildDispatchCreatedAtFilter — empty when no dates", () => {
  assert.equal(buildDispatchCreatedAtFilter({}), null);
});
