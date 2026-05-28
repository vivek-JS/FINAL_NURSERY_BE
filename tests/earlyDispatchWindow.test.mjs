import test from "node:test";
import assert from "node:assert/strict";
import { isDateOutsideSlotWindow } from "../utility/findDeliverySlot.js";
import {
  shouldRevertEarlyDispatch,
  shouldApplyEarlyDispatch,
} from "../services/earlyDispatch.service.js";

test("isDateOutsideSlotWindow — date inside window", () => {
  const slot = { startDay: "01-05-2026", endDay: "15-05-2026" };
  const inside = new Date(Date.UTC(2026, 4, 10, 12, 0, 0));
  assert.equal(isDateOutsideSlotWindow(inside, slot), false);
});

test("isDateOutsideSlotWindow — overdue dispatch today outside past window", () => {
  const slot = { startDay: "01-05-2026", endDay: "15-05-2026" };
  const today = new Date(Date.UTC(2026, 4, 28, 12, 0, 0));
  assert.equal(isDateOutsideSlotWindow(today, slot), true);
});

test("shouldRevertEarlyDispatch when leaving ready queue", () => {
  assert.equal(
    shouldRevertEarlyDispatch("READY_FOR_DISPATCH", "FARM_READY", {
      dispatchedFromAnotherSlot: true,
    }),
    true
  );
});

test("shouldApplyEarlyDispatch only for READY_FOR_DISPATCH target", () => {
  assert.equal(shouldApplyEarlyDispatch("FARM_READY", "READY_FOR_DISPATCH"), true);
  assert.equal(shouldApplyEarlyDispatch("READY_FOR_DISPATCH", "DISPATCHED"), false);
});
