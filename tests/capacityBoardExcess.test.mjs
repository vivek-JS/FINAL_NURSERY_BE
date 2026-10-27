import test from "node:test";
import assert from "node:assert/strict";
import { batchCountsOnCapacityBoard } from "../utility/capacityBoardExcess.js";
import { slotReportedExcess } from "../utility/lagwadSlotPlantsSplit.js";
import { computeSowingGapBoardMetricsForSubtype } from "../utility/sowingGapSummaryMetrics.js";

test("irrelevant batches never count on the capacity board", () => {
  assert.equal(batchCountsOnCapacityBoard({ isIrrelevant: true, plantsSowed: 10000 }), false);
  assert.equal(batchCountsOnCapacityBoard({ isIrrelevant: false, plantsSowed: 10000 }), true);
  assert.equal(batchCountsOnCapacityBoard(null), false);
});

test("old watermelon leftover still counts when not marked irrelevant", () => {
  assert.equal(
    batchCountsOnCapacityBoard({
      plantReadyDate: "01-10-2026",
      plantsSowed: 10000,
      isIrrelevant: false,
    }),
    true
  );
});

test("slot excess skips only irrelevant batches", () => {
  const batches = [
    { plantsSowed: 10000, orderCoveredPlants: 0, isIrrelevant: true },
    { plantsSowed: 10000, orderCoveredPlants: 8000, plantReadyDate: "20-10-2026" },
    { plantsSowed: 10000, orderCoveredPlants: 7000, plantReadyDate: "26-10-2026" },
  ];
  assert.equal(slotReportedExcess(batches, 0, batchCountsOnCapacityBoard), 5000);
  assert.equal(slotReportedExcess(batches, 0), 5000);
});

test("board metrics keep non-irrelevant excess regardless of ready age", () => {
  const metrics = computeSowingGapBoardMetricsForSubtype(
    [
      {
        slotId: "old",
        slotStartDay: "20-10-2026",
        slotEndDay: "20-10-2026",
        primarySowed: 10000,
        sowingBatches: [
          { plantsSowed: 10000, orderCoveredPlants: 0, plantReadyDate: "20-10-2026" },
        ],
      },
      {
        slotId: "skip",
        slotStartDay: "20-10-2026",
        slotEndDay: "20-10-2026",
        primarySowed: 10000,
        sowingBatches: [
          {
            plantsSowed: 10000,
            orderCoveredPlants: 0,
            plantReadyDate: "20-10-2026",
            isIrrelevant: true,
          },
        ],
      },
    ],
    [],
    0
  );
  assert.equal(metrics.get("old").excessAvailableForBooking, 10000);
  assert.equal(metrics.get("skip").excessAvailableForBooking, 0);
});
