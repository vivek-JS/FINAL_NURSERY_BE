import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveSlotBufferFields,
  deriveSlotCapacity,
  isAvailablePlantsMaterialized,
} from "../utility/bufferUtils.js";

test("legacy unmigrated slot derives available from old totalPlants", () => {
  const resolved = resolveSlotBufferFields({
    totalPlants: 50000,
    availablePlants: 0,
    totalBookedPlants: 10000,
    bufferAmount: 5000,
    originalTotalPlants: 50000,
  });
  assert.equal(resolved.availablePlants, 35000);
  assert.equal(resolved.totalCapacity, 45000);
});

test("capacity is available + booked", () => {
  assert.equal(deriveSlotCapacity(31000, 10000), 41000);
  const resolved = resolveSlotBufferFields({
    availablePlants: 31000,
    availablePlantsMaterialized: true,
    totalPlants: 50000,
    totalBookedPlants: 10000,
  });
  assert.equal(resolved.availablePlants, 31000);
  assert.equal(resolved.totalCapacity, 41000);
});

test("stored zero available is kept and capacity equals booked", () => {
  const resolved = resolveSlotBufferFields({
    availablePlants: 0,
    availablePlantsMaterialized: true,
    totalPlants: 50000,
    totalBookedPlants: 10000,
  });
  assert.equal(resolved.availablePlants, 0);
  assert.equal(resolved.totalCapacity, 10000);
});

test("trail entry AVAILABLE_PLANTS_UPDATED marks materialized", () => {
  const slot = {
    availablePlants: 0,
    slotTrail: [{ action: "AVAILABLE_PLANTS_UPDATED" }],
    totalPlants: 50000,
    totalBookedPlants: 10000,
  };
  assert.equal(isAvailablePlantsMaterialized(slot), true);
  assert.equal(resolveSlotBufferFields(slot).availablePlants, 0);
  assert.equal(resolveSlotBufferFields(slot).totalCapacity, 10000);
});

test("negative stored available is kept for unmigrated overbooked slots", () => {
  const resolved = resolveSlotBufferFields({
    availablePlants: -8000,
    totalPlants: 80000,
    totalBookedPlants: 80000,
  });
  assert.equal(resolved.availablePlants, -8000);
  assert.equal(resolved.totalCapacity, 80000);
});
