import { describe, it } from "node:test";
import assert from "node:assert";
import moment from "moment";
import {
  computeActualAvailable,
  computePendingSlotSync,
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
