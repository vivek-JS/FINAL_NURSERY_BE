import test from "node:test";
import assert from "node:assert/strict";
import { applyStockFieldUpdates } from "../utility/slotStockTrail.js";

test("applyStockFieldUpdates sets available to 0 from negative overbook", () => {
  const slot = {
    availablePlants: -8000,
    totalPlants: 72000,
    totalBookedPlants: 80000,
    slotTrail: [],
  };

  applyStockFieldUpdates(slot, { availablePlants: 0 }, null, "Slot update");

  assert.equal(slot.availablePlants, 0);
  assert.equal(slot.availablePlantsMaterialized, true);
  assert.equal(slot.totalPlants, 80000);
  assert.equal(slot.isOverflow, false);
});

test("applyStockFieldUpdates adds to negative available correctly", () => {
  const slot = {
    availablePlants: -8000,
    totalPlants: 72000,
    totalBookedPlants: 80000,
    slotTrail: [],
  };

  applyStockFieldUpdates(slot, { availablePlants: 0 }, null, "Slot update");

  assert.equal(slot.availablePlants, 0);
});
