import test from "node:test";
import assert from "node:assert/strict";
import moment from "moment";
import {
  canBookPlants,
  capacityStatus,
  majoritySeedPlan,
  slotOverlapsRange,
} from "../utility/capacitySheetMetrics.js";
import { IST_OFFSET } from "../utility/istSlotDate.js";

test("status prefers sowing gap over excess", () => {
  assert.equal(capacityStatus({ gap: 10, excess: 5 }), "needs_sowing");
  assert.equal(capacityStatus({ gap: 0, excess: 5 }), "saleable_excess");
  assert.equal(capacityStatus({ gap: 0, excess: 0 }), "fulfilled");
});

test("can book never goes below zero", () => {
  assert.equal(canBookPlants(1000, 400, 100), 500);
  assert.equal(canBookPlants(100, 200, 0), 0);
});

test("majority seed plan uses pipeline orders", () => {
  const orders = [
    { orderStatus: "ACCEPTED", sowingPlan: { seedSource: "RAISING" } },
    { orderStatus: "ACCEPTED", sowingPlan: { seedSource: "RAISING" } },
    { orderStatus: "PENDING", sowingPlan: { seedSource: "COMPANY" } },
    { orderStatus: "CANCELLED", sowingPlan: { seedSource: "COMPANY" } },
  ];
  assert.equal(majoritySeedPlan(orders), "RAISING");
  assert.equal(majoritySeedPlan([]), "COMPANY");
});

test("slot overlap uses calendar days, not DD-MM string order", () => {
  const from = moment("2026-10-15", "YYYY-MM-DD").utcOffset(IST_OFFSET, true).startOf("day");
  const to = moment("2026-10-21", "YYYY-MM-DD").utcOffset(IST_OFFSET, true).endOf("day");
  assert.equal(slotOverlapsRange("20-10-2026", "22-10-2026", from, to), true);
  assert.equal(slotOverlapsRange("01-11-2026", "05-11-2026", from, to), false);
  assert.equal(slotOverlapsRange("01-09-2026", "10-10-2026", from, to), false);
});
