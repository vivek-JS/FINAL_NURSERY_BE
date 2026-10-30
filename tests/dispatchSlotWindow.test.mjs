import test from "node:test";
import assert from "node:assert/strict";
import { lagwadInSlot, orderInSlot } from "../utility/dispatchSlotWindow.js";

const first = { from: "2026-10-30", to: "2026-11-03", includeOverdue: true, lookbackStart: "2026-09-30" };
const next = { from: "2026-11-04", to: "2026-11-08", includeOverdue: false, lookbackStart: "2026-09-30" };

test("first slot keeps past-due orders inside the lookback", () => {
  assert.equal(orderInSlot("2026-10-20", first), true);
  assert.equal(orderInSlot("2026-09-01", first), false);
  assert.equal(orderInSlot("2026-11-01", first), true);
  assert.equal(orderInSlot("2026-11-04", first), false);
  assert.equal(orderInSlot("", first), true);
});

test("later slot is only its own dates", () => {
  assert.equal(orderInSlot("2026-10-20", next), false);
  assert.equal(orderInSlot("2026-11-06", next), true);
  assert.equal(orderInSlot("", next), false);
});

test("first slot keeps already-ready lagwad, later slot does not", () => {
  assert.equal(lagwadInSlot("2026-10-01", first), true);
  assert.equal(lagwadInSlot("2026-11-02", first), true);
  assert.equal(lagwadInSlot("2026-11-09", first), false);
  assert.equal(lagwadInSlot("", first), true);
  assert.equal(lagwadInSlot("2026-10-01", next), false);
  assert.equal(lagwadInSlot("2026-11-06", next), true);
});
