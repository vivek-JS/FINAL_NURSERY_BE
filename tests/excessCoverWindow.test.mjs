import test from "node:test";
import assert from "node:assert/strict";
import {
  EXCESS_PAST_READY_DAYS,
  excessReadyInWindow,
} from "../utility/excessCoverWindow.js";

test("excessReadyInWindow allows older ready stock up to the past cap", () => {
  assert.equal(EXCESS_PAST_READY_DAYS, 45);
  assert.equal(excessReadyInWindow(-45, 5), true);
  assert.equal(excessReadyInWindow(-46, 5), false);
});

test("excessReadyInWindow uses the caller forward window for future ready stock", () => {
  assert.equal(excessReadyInWindow(5, 5), true);
  assert.equal(excessReadyInWindow(6, 5), false);
});

test("excessReadyInWindow rejects invalid offsets and honors custom past caps", () => {
  assert.equal(excessReadyInWindow("not-a-day", 5), false);
  assert.equal(excessReadyInWindow(-10, 5, 10), true);
  assert.equal(excessReadyInWindow(-11, 5, 10), false);
});
