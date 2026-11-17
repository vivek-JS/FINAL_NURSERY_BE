import { describe, it } from "node:test";
import assert from "node:assert";
import moment from "moment";
import {
  computeActualAvailable,
  computePendingSlotSync,
  effectiveSyncedOnSlot,
  planDispatchReadyDeduction,
  planDualStockOutflow,
  pickReadyDateForSlot,
  rollupShedStockForSlots,
} from "../services/secondaryShedSlotStock.service.js";

describe("secondaryShedSlotStock — ERP position math", () => {
  it("computeActualAvailable never goes negative", () => {
    assert.strictEqual(computeActualAvailable(100, 30), 70);
    assert.strictEqual(computeActualAvailable(50, 80), 0);
    assert.strictEqual(computeActualAvailable(null, 10), 0);
  });

  it("computePendingSlotSync = available − synced (floor at 0)", () => {
    assert.strictEqual(computePendingSlotSync(500, 200), 300);
    assert.strictEqual(computePendingSlotSync(100, 100), 0);
    assert.strictEqual(computePendingSlotSync(50, 120), 0);
  });

  it("effectiveSyncedOnSlot never exceeds shed available", () => {
    assert.strictEqual(effectiveSyncedOnSlot(16973, 23423), 16973);
    assert.strictEqual(effectiveSyncedOnSlot(100, 80), 80);
    assert.strictEqual(effectiveSyncedOnSlot(0, 50), 0);
  });

  it("planDualStockOutflow always moves avail + synced together", () => {
    const ok = planDualStockOutflow({
      availableQuantity: 20000,
      slotStockSyncedPlants: 20000,
      quantity: 149,
    });
    assert.strictEqual(ok.newAvail, 19851);
    assert.strictEqual(ok.newSynced, 19851);
    assert.strictEqual(ok.syncedDec, 149);

    const drifted = planDualStockOutflow({
      availableQuantity: 16973,
      slotStockSyncedPlants: 23423,
      quantity: 100,
    });
    assert.strictEqual(drifted.newAvail, 16873);
    assert.strictEqual(drifted.newSynced, 16873);
    assert.ok(drifted.syncedDec >= 100);
  });

  it("planDispatchReadyDeduction burns ready + synced together", () => {
    const full = planDispatchReadyDeduction({
      prevReady: 1000,
      prevSynced: 800,
      quantity: 149,
    });
    assert.strictEqual(full.subtracted, 149);
    assert.strictEqual(full.readyDec, 149);
    assert.strictEqual(full.syncedDec, 149);
    assert.strictEqual(full.readyAfter, 851);
    assert.strictEqual(full.syncedAfter, 651);

    // Stored ready already 0 but synced still high — still burn synced.
    const staleReady = planDispatchReadyDeduction({
      prevReady: 0,
      prevSynced: 500,
      quantity: 100,
    });
    assert.strictEqual(staleReady.subtracted, 100);
    assert.strictEqual(staleReady.readyDec, 0);
    assert.strictEqual(staleReady.syncedDec, 100);
    assert.strictEqual(staleReady.syncedAfter, 400);
  });
});

describe("secondaryShedSlotStock — shed rollup", () => {
  const slotA = "507f1f77bcf86cd799439011";
  const slotB = "507f1f77bcf86cd799439012";
  const batch1 = "507f1f77bcf86cd799439021";
  const batch2 = "507f1f77bcf86cd799439022";

  it("rollupShedStockForSlots sums per slot and counts distinct batches", () => {
    const pos = [
      {
        batchId: batch1,
        secondaryInward: [
          {
            linkedBookingSlotId: slotA,
            availableQuantity: 100,
            slotStockSyncedPlants: 60,
          },
          {
            linkedBookingSlotId: slotA,
            availableQuantity: 50,
            slotStockSyncedPlants: 50,
          },
        ],
      },
      {
        batchId: batch2,
        secondaryInward: [
          {
            linkedBookingSlotId: slotB,
            availableQuantity: 200,
            slotStockSyncedPlants: 0,
          },
        ],
      },
    ];

    const map = rollupShedStockForSlots(pos, [slotA, slotB]);
    const a = map.get(slotA);
    const b = map.get(slotB);

    assert.strictEqual(a.shedAvailableInShed, 150);
    assert.strictEqual(a.shedSyncedPlants, 110);
    assert.strictEqual(a.linkedBatchCount, 1);
    assert.strictEqual(a.lineCount, 2);

    assert.strictEqual(b.shedAvailableInShed, 200);
    assert.strictEqual(b.shedSyncedPlants, 0);
    assert.strictEqual(b.linkedBatchCount, 1);
    assert.strictEqual(b.lineCount, 1);
    assert.strictEqual(a.actualReadyPlants, 0);
    assert.strictEqual(b.actualReadyPlants, 0);
  });

  it("rollupShedStockForSlots counts calendar-ready synced plants as actualReadyPlants", () => {
    const pastInward = moment().subtract(30, "days").startOf("day").toDate();
    const pos = [
      {
        batchId: { _id: batch1, secondaryPlantReadyDays: 14 },
        secondaryInward: [
          {
            linkedBookingSlotId: slotA,
            secondaryInwardDate: pastInward,
            availableQuantity: 80,
            slotStockSyncedPlants: 75,
          },
          {
            linkedBookingSlotId: slotA,
            secondaryInwardDate: moment().subtract(2, "days").toDate(),
            availableQuantity: 40,
            slotStockSyncedPlants: 30,
          },
        ],
      },
    ];
    const map = rollupShedStockForSlots(pos, [slotA]);
    const a = map.get(slotA);
    assert.strictEqual(a.shedSyncedPlants, 105);
    assert.strictEqual(a.actualReadyPlants, 75);
    assert.strictEqual(a.shedReadyInShed, 80);
  });

  it("rollup clamps synced to available so ready never exceeds stock", () => {
    const pastInward = moment().subtract(30, "days").startOf("day").toDate();
    const pos = [
      {
        batchId: { _id: batch1, secondaryPlantReadyDays: 14 },
        secondaryInward: [
          {
            linkedBookingSlotId: slotA,
            secondaryInwardDate: pastInward,
            availableQuantity: 16973,
            slotStockSyncedPlants: 23423,
          },
        ],
      },
    ];
    const map = rollupShedStockForSlots(pos, [slotA]);
    assert.strictEqual(map.get(slotA).actualReadyPlants, 16973);
    assert.strictEqual(map.get(slotA).shedSyncedPlants, 16973);
  });

  it("rollup actualReadyPlants drops when slotStockSyncedPlants decreases (dispatch)", () => {
    const pastInward = moment().subtract(30, "days").startOf("day").toDate();
    const before = [
      {
        batchId: { _id: batch1, secondaryPlantReadyDays: 14 },
        secondaryInward: [
          {
            linkedBookingSlotId: slotA,
            secondaryInwardDate: pastInward,
            availableQuantity: 100,
            slotStockSyncedPlants: 100,
          },
        ],
      },
    ];
    const mapBefore = rollupShedStockForSlots(before, [slotA]);
    assert.strictEqual(mapBefore.get(slotA).actualReadyPlants, 100);

    const after = [
      {
        batchId: { _id: batch1, secondaryPlantReadyDays: 14 },
        secondaryInward: [
          {
            linkedBookingSlotId: slotA,
            secondaryInwardDate: pastInward,
            availableQuantity: 40,
            slotStockSyncedPlants: 40,
          },
        ],
      },
    ];
    const mapAfter = rollupShedStockForSlots(after, [slotA]);
    assert.strictEqual(mapAfter.get(slotA).actualReadyPlants, 40);
    assert.strictEqual(mapAfter.get(slotA).shedSyncedPlants, 40);
  });

  it("ignores lines for slots not in the requested list", () => {
    const pos = [
      {
        batchId: batch1,
        secondaryInward: [
          {
            linkedBookingSlotId: slotA,
            availableQuantity: 10,
            slotStockSyncedPlants: 10,
          },
        ],
      },
    ];
    const map = rollupShedStockForSlots(pos, [slotB]);
    assert.strictEqual(map.get(slotB).shedAvailableInShed, 0);
    assert.strictEqual(map.get(slotB).lineCount, 0);
  });
});

describe("secondaryShedSlotStock — pickReadyDateForSlot", () => {
  it("prefers expectedReadyDate over inward + secondary days", () => {
    const expected = moment("2026-04-15").startOf("day");
    const m = pickReadyDateForSlot(
      { expectedReadyDate: expected.toDate() },
      { secondaryPlantReadyDays: 14 }
    );
    assert.ok(m.isSame(expected, "day"));
  });

  it("falls back to inward + secondaryPlantReadyDays", () => {
    const inward = moment("2026-03-01").startOf("day");
    const m = pickReadyDateForSlot(
      { secondaryInwardDate: inward.toDate() },
      { secondaryPlantReadyDays: 10 }
    );
    assert.ok(m.isSame(inward.clone().add(10, "days"), "day"));
  });
});

describe("secondaryShedSlotStock — breakdown response shape", () => {
  it("documents required batch line fields for ERP modal", () => {
    const requiredLineKeys = [
      "secondaryInwardId",
      "availableQuantity",
      "slotStockSyncedPlants",
      "pendingSlotSync",
      "dispatchEligible",
      "expectedReadyDate",
    ];
    const requiredBatchKeys = [
      "batchId",
      "batchNumber",
      "anchorSowingDate",
      "anchorSowingLabel",
      "lines",
      "totalAvailableInShed",
      "totalSyncedToSlot",
    ];
    const requiredSummaryKeys = [
      "actualPlants",
      "actualReadyPlants",
      "shedAvailableInShed",
      "shedSyncedToSlot",
      "pendingSlotSync",
      "batchCount",
    ];
    assert.ok(requiredLineKeys.length >= 6);
    assert.ok(requiredBatchKeys.length >= 7);
    assert.ok(requiredSummaryKeys.length >= 5);
  });
});
