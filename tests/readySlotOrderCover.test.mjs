import test from "node:test";
import assert from "node:assert/strict";
import {
  coverOffsetDays,
  inReadyCoverWindow,
  shouldRebookOntoReady,
} from "../utility/readySlotOrderCover.js";

test("12 Nov booking is +1d from 11 Nov ready", () => {
  assert.equal(coverOffsetDays("12-11-2026", "11-11-2026"), 1);
  assert.equal(coverOffsetDays("2026-11-12", "11-11-2026"), 1);
});

test("IST delivery 12 Nov vs ready 11 Nov uses calendar days", () => {
  assert.equal(coverOffsetDays("2026-11-11T18:30:00.000Z", "11-11-2026"), 1);
});

test("±5d window covers the next-day order slot", () => {
  assert.equal(inReadyCoverWindow(1, 5), true);
  assert.equal(inReadyCoverWindow(6, 5), false);
  assert.equal(shouldRebookOntoReady("12-11-2026", "11-11-2026", 5), true);
  assert.equal(shouldRebookOntoReady("11-11-2026", "11-11-2026", 5), false);
  assert.equal(shouldRebookOntoReady("20-11-2026", "11-11-2026", 5), false);
});
