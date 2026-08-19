/**
 * Secondary slot cases: 90% actual / 10% mortality / actualReady dispatch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import moment from "moment";
import {
  simulateLagwadSlotSync,
  simulateDispatchLagwadRemaining,
  rollupShedStockForSlots,
} from "../services/secondaryShedSlotStock.service.js";
import { splitPlantsAcrossOrdersFifo } from "../services/secondaryVehicleLoad.service.js";

const SLOT = "507f1f77bcf86cd799439011";
const BATCH = "507f1f77bcf86cd799439021";

function rollupLine(avail, synced, inwardDaysAgo = 30) {
  const pastInward = moment().subtract(inwardDaysAgo, "days").startOf("day").toDate();
  const pos = [
    {
      batchId: { _id: BATCH, secondaryPlantReadyDays: 14 },
      secondaryInward: [
        {
          linkedBookingSlotId: SLOT,
          secondaryInwardDate: pastInward,
          availableQuantity: avail,
          slotStockSyncedPlants: synced,
        },
      ],
    },
  ];
  return rollupShedStockForSlots(pos, [SLOT]).get(SLOT);
}

describe("case — lagwad sync (90/10)", () => {
  it("applies 90% to actual delta and 10% mortality on pending", () => {
    const r = simulateLagwadSlotSync(500, 200);
    assert.equal(r.pending, 250);
    assert.equal(r.actualPlantsDelta, 250);
    assert.equal(r.expectedMortalityDelta, 28);
    assert.equal(r.syncedAfter, 450);
    assert.equal(r.readyOnly, false);
    assert.equal(r.lagwadRemainingDelta, 0);
  });

  it("rollup actualReady rises to 90% synced on calendar-ready line", () => {
    const before = rollupLine(500, 200);
    assert.equal(before.actualReadyPlants, 200);

    const afterSync = simulateLagwadSlotSync(500, 200);
    const after = rollupLine(500, afterSync.syncedAfter);
    assert.equal(after.actualReadyPlants, 450);
    assert.equal(after.shedSyncedPlants, 450);
  });
});

describe("case — dispatch actual ready", () => {
  it("subtracts actualReady only — not actualPlants", () => {
    let actualPlants = 180;
    let actualReady = 180;

    const d = simulateDispatchLagwadRemaining(actualReady, 120);
    actualReady = d.actualReadyAfter;
    assert.equal(d.subtracted, 120);
    assert.equal(d.actualPlantsDelta, 0);
    assert.equal(d.actualReadyDelta, -120);
    assert.equal(actualReady, 60);
    assert.equal(actualPlants, 180);
  });

  it("caps dispatch at actualReady", () => {
    const d = simulateDispatchLagwadRemaining(40, 100);
    assert.equal(d.subtracted, 40);
    assert.equal(d.actualReadyAfter, 0);
  });
});

describe("case — not calendar ready", () => {
  it("synced exists but rollup actualReady is 0 until calendar/bypass", () => {
    const recent = moment().subtract(2, "days").startOf("day").toDate();
    const pos = [
      {
        batchId: { _id: BATCH, secondaryPlantReadyDays: 14 },
        secondaryInward: [
          {
            linkedBookingSlotId: SLOT,
            secondaryInwardDate: recent,
            availableQuantity: 100,
            slotStockSyncedPlants: 90,
          },
        ],
      },
    ];
    const r = rollupShedStockForSlots(pos, [SLOT]).get(SLOT);
    assert.equal(r.shedSyncedPlants, 90);
    assert.equal(r.actualReadyPlants, 0);
    assert.equal(r.shedReadyInShed, 0);
  });

  it("readiness bypass counts as calendar ready in rollup", () => {
    const recent = moment().subtract(2, "days").startOf("day").toDate();
    const pos = [
      {
        batchId: { _id: BATCH, secondaryPlantReadyDays: 14 },
        secondaryInward: [
          {
            linkedBookingSlotId: SLOT,
            secondaryInwardDate: recent,
            availableQuantity: 80,
            slotStockSyncedPlants: 72,
            readinessBypassAt: new Date(),
          },
        ],
      },
    ];
    const r = rollupShedStockForSlots(pos, [SLOT]).get(SLOT);
    assert.equal(r.actualReadyPlants, 72);
    assert.equal(r.shedReadyInShed, 80);
  });
});

describe("case — multi-order FIFO (dispatch load)", () => {
  it("does not over-allocate per order remaining", () => {
    const rem = new Map([
      ["o1", 50],
      ["o2", 30],
    ]);
    const parts = splitPlantsAcrossOrdersFifo(100, ["o1", "o2"], rem);
    assert.equal(parts.reduce((s, p) => s + p.plants, 0), 80);
    assert.deepEqual(parts, [
      { orderId: "o1", plants: 50 },
      { orderId: "o2", plants: 30 },
    ]);
  });
});

describe("case — full lifecycle matrix (90/10)", () => {
  it("lagwad → dispatch → unload on actualReady", () => {
    let actualPlants = 0;
    let expectedMortality = 0;
    let actualReady = 0;
    let synced = 0;

    const lagwad = simulateLagwadSlotSync(200, synced);
    actualPlants += lagwad.actualPlantsDelta;
    expectedMortality += lagwad.expectedMortalityDelta;
    actualReady += lagwad.readyDelta;
    synced = lagwad.syncedAfter;

    assert.equal(actualPlants, 180);
    assert.equal(expectedMortality, 20);
    assert.equal(actualReady, 180);
    assert.equal(synced, 180);

    const roll = rollupLine(200, synced);
    assert.equal(roll.actualReadyPlants, 180);

    const dispatch = simulateDispatchLagwadRemaining(actualReady, 120);
    actualReady = dispatch.actualReadyAfter;
    assert.equal(actualPlants, 180);
    assert.equal(actualReady, 60);

    actualReady += 30;
    assert.equal(actualReady, 90);
  });
});
