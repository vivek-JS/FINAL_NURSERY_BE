import test from "node:test";
import assert from "node:assert/strict";
import {
  SLOT_TRAIL_ACTION_ENUM,
  SLOT_TRAIL_ACTIONS,
  STOCK_TRAIL_ACTION_LIST,
  getSlotTrailActivityName,
} from "../constants/slotTrailActions.js";
import { logStockFieldChange } from "../utility/slotStockTrail.js";

test("stock trail actions are valid slotTrail enum values", () => {
  for (const action of STOCK_TRAIL_ACTION_LIST) {
    assert.ok(
      SLOT_TRAIL_ACTION_ENUM.includes(action),
      `${action} must be in SLOT_TRAIL_ACTION_ENUM`
    );
  }
});

test("AVAILABLE_PLANTS_UPDATED has a display label", () => {
  assert.equal(
    getSlotTrailActivityName(SLOT_TRAIL_ACTIONS.AVAILABLE_PLANTS_UPDATED),
    "Available Plants Updated"
  );
});

test("logStockFieldChange uses AVAILABLE_PLANTS_UPDATED for availablePlants", () => {
  const slot = {
    totalPlants: 50000,
    availablePlants: 1000,
    slotTrail: [],
  };

  const changed = logStockFieldChange(
    slot,
    "availablePlants",
    1000,
    31000,
    null,
    "Slot update"
  );

  assert.equal(changed, true);
  assert.equal(slot.slotTrail.length, 1);
  assert.equal(slot.slotTrail[0].action, SLOT_TRAIL_ACTIONS.AVAILABLE_PLANTS_UPDATED);
  assert.equal(slot.slotTrail[0].activityName, "Available Plants Updated");
  assert.equal(slot.slotTrail[0].previousAvailablePlants, 1000);
  assert.equal(slot.slotTrail[0].newAvailablePlants, 31000);
});
