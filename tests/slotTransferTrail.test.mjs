import test from "node:test";
import assert from "node:assert/strict";
import {
  SLOT_TRAIL_ACTION_ENUM,
  SLOT_TRAIL_ACTIONS,
  TRANSFER_TRAIL_ACTION_LIST,
  getSlotTrailActivityName,
} from "../constants/slotTrailActions.js";
import {
  applyOrderTransferToSlotMemory,
  buildSlotSnapshot,
  computeAvailableFromBooked,
  computeAvailableOverflowFromBooked,
} from "../utility/slotTransferTrail.js";

test("transfer trail actions are valid slotTrail enum values", () => {
  for (const action of TRANSFER_TRAIL_ACTION_LIST) {
    assert.ok(
      SLOT_TRAIL_ACTION_ENUM.includes(action),
      `${action} must be in SLOT_TRAIL_ACTION_ENUM`
    );
  }
});

test("transfer trail actions have display labels", () => {
  assert.equal(
    getSlotTrailActivityName(SLOT_TRAIL_ACTIONS.ORDER_SLOT_TRANSFER_OUT),
    "Order moved to another slot"
  );
  assert.equal(
    getSlotTrailActivityName(SLOT_TRAIL_ACTIONS.SOWING_TRANSFER_IN),
    "Sowing surplus transferred in"
  );
  assert.equal(
    getSlotTrailActivityName(SLOT_TRAIL_ACTIONS.CAPACITY_TRANSFER_OUT),
    "Capacity transferred out"
  );
});

test("buildSlotSnapshot includes booked and sowing fields", () => {
  const snap = buildSlotSnapshot({
    primarySowed: 1200,
    officeSowed: 100,
    plantsSowed: 1300,
    totalPlants: 5000,
    availablePlants: 800,
    totalBookedPlants: 3500,
    actualPlants: 4000,
    closingStock: 3900,
    sowingInProgress: [{}, {}],
  });

  assert.equal(snap.primarySowed, 1200);
  assert.equal(snap.plantsSowed, 1300);
  assert.equal(snap.totalBookedPlants, 3500);
  assert.equal(snap.availablePlants, 800);
  assert.equal(snap.inProgressCount, 2);
  assert.equal(snap.actualPlants, 4000);
});

test("buildSlotSnapshot returns zeros for null slot", () => {
  const snap = buildSlotSnapshot(null);
  assert.equal(snap.totalBookedPlants, 0);
  assert.equal(snap.primarySowed, 0);
});

test("TRANSFER_TRAIL_ACTION_LIST has six cross-slot actions", () => {
  assert.equal(TRANSFER_TRAIL_ACTION_LIST.length, 6);
  assert.ok(TRANSFER_TRAIL_ACTION_LIST.includes(SLOT_TRAIL_ACTIONS.ORDER_SLOT_TRANSFER_IN));
});

test("computeAvailableFromBooked is total minus booked minus buffer floored at 0", () => {
  assert.equal(
    computeAvailableFromBooked({
      totalPlants: 1000,
      totalBookedPlants: 700,
      bufferAmount: 50,
    }),
    250
  );
  assert.equal(
    computeAvailableFromBooked({
      totalPlants: 500,
      totalBookedPlants: 600,
      bufferAmount: 0,
    }),
    0
  );
});

test("computeAvailableOverflowFromBooked flags overbooked slots", () => {
  const over = computeAvailableOverflowFromBooked({
    totalPlants: 500,
    totalBookedPlants: 600,
    bufferAmount: 0,
  });
  assert.equal(over.availablePlants, -100);
  assert.equal(over.isOverflow, true);
});

test("computeAvailableOverflowFromBooked uses order-booked override", () => {
  const result = computeAvailableOverflowFromBooked(
    { totalPlants: 1000, totalBookedPlants: 900, bufferAmount: 0 },
    400
  );
  assert.equal(result.availablePlants, 600);
  assert.equal(result.totalBookedPlants, 400);
  assert.equal(result.totalPlants, 1000);
});

test("non-sowing order transfer memory: release frees booked-derived available", () => {
  const slot = {
    totalPlants: 1000,
    totalBookedPlants: 800,
    bufferAmount: 0,
    availablePlants: 50,
  };
  applyOrderTransferToSlotMemory(slot, 200, "release");
  assert.equal(slot.totalBookedPlants, 600);
  assert.equal(slot.availablePlants, 400);
});

test("non-sowing order transfer memory: book reduces available", () => {
  const slot = {
    totalPlants: 1000,
    totalBookedPlants: 400,
    bufferAmount: 100,
    availablePlants: 900,
  };
  applyOrderTransferToSlotMemory(slot, 150, "book");
  assert.equal(slot.totalBookedPlants, 550);
  assert.equal(slot.availablePlants, 350);
});

test("sowing slot order transfer: available derived from booked formula", () => {
  const slot = {
    totalPlants: 1000,
    totalBookedPlants: 500,
    bufferAmount: 0,
    availablePlants: 200,
  };
  applyOrderTransferToSlotMemory(slot, 100, "release");
  assert.equal(slot.totalBookedPlants, 400);
  assert.equal(slot.availablePlants, 600);
});
