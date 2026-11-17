import test from "node:test";
import assert from "node:assert/strict";
import {
  batchSaleableStock,
  isSuperAdminUser,
  isWatermelonPlantName,
  planIrrelevantStockPull,
  readyBeforeYmd,
  remainingAfterOut,
} from "../services/sowBatchIrrelevant.service.js";

test("watermelon ready before 14 Oct 2026 is in the backfill window", () => {
  assert.equal(isWatermelonPlantName("Watermelon"), true);
  assert.equal(isWatermelonPlantName("Ram Tarbuja"), true);
  assert.equal(isWatermelonPlantName("Papaya"), false);
  assert.equal(readyBeforeYmd("13-10-2026"), true);
  assert.equal(readyBeforeYmd("14-10-2026"), false);
  assert.equal(readyBeforeYmd("01-09-2026"), true);
  assert.equal(readyBeforeYmd(""), false);
});

test("super admin is job title or role", () => {
  assert.equal(isSuperAdminUser({ jobTitle: "SUPER_ADMIN" }), true);
  assert.equal(isSuperAdminUser({ role: "SUPERADMIN" }), true);
  assert.equal(isSuperAdminUser({ jobTitle: "OFFICE_ADMIN", role: "OFFICE_ADMIN" }), false);
});

test("plan pulls saleable excess off the slot and restores the same amount", () => {
  const batch = { plantsSowed: 10000, excessPlants: 10000, availablePlantsApplied: 9000 };
  assert.equal(batchSaleableStock(batch), 9000);
  const slot = { availablePlants: 12000, excessiveSowing: { plants: 12000 } };
  const marked = planIrrelevantStockPull({ slot, batch, mark: true });
  assert.equal(marked.pulled, 9000);
  assert.equal(marked.availablePlants, 3000);
  assert.equal(marked.excessivePlants, 3000);
  const restored = planIrrelevantStockPull({
    slot: { availablePlants: marked.availablePlants, excessiveSowing: { plants: marked.excessivePlants } },
    batch: { isIrrelevant: true, irrelevantStockPulled: marked.pulled },
    mark: false,
  });
  assert.equal(restored.availablePlants, 12000);
  assert.equal(restored.excessivePlants, 12000);
  assert.equal(restored.pulled, 0);
});

test("plan clamps the pull at the slot's current available plants", () => {
  const marked = planIrrelevantStockPull({
    slot: { availablePlants: 400, excessiveSowing: { plants: 400 } },
    batch: { availablePlantsApplied: 9000 },
    mark: true,
  });
  assert.equal(marked.pulled, 400);
  assert.equal(marked.availablePlants, 0);
  assert.match(
    planIrrelevantStockPull({
      slot: { availablePlants: 0 },
      batch: { isIrrelevant: true },
      mark: true,
    }).error,
    /already irrelevant/
  );
});

test("remaining after Out is sowed minus buffer minus dispatched", () => {
  assert.equal(
    remainingAfterOut(
      { plantsSowed: 41580, bufferPlants: 0 },
      { outPlants: 36590, bufferPlants: 4990 }
    ),
    0
  );
  assert.equal(remainingAfterOut({ plantsSowed: 10000, bufferPlants: 1000 }, { outPlants: 2000 }), 7000);
});

test("mark old does not pull plants already Out", () => {
  const marked = planIrrelevantStockPull({
    slot: { availablePlants: 12000, excessiveSowing: { plants: 12000 } },
    batch: { plantsSowed: 41580, availablePlantsApplied: 7922, bufferPlants: 0 },
    mark: true,
    outPlants: 36590,
    bufferPlants: 4990,
  });
  assert.equal(batchSaleableStock(
    { plantsSowed: 41580, availablePlantsApplied: 7922, bufferPlants: 0 },
    { outPlants: 36590, bufferPlants: 4990 }
  ), 0);
  assert.equal(marked.pulled, 0);
  assert.equal(marked.availablePlants, 12000);
});
