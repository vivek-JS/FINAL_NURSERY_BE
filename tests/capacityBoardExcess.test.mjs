import test from "node:test";
import assert from "node:assert/strict";
import {
  WATERMELON_BOARD_PAST_READY_DAYS,
  batchCountsOnCapacityBoard,
} from "../utility/capacityBoardExcess.js";
import { slotReportedExcess } from "../utility/lagwadSlotPlantsSplit.js";
import { computeSowingGapBoardMetricsForSubtype } from "../utility/sowingGapSummaryMetrics.js";

test("watermelon board past-ready window is 4 days", () => {
  assert.equal(WATERMELON_BOARD_PAST_READY_DAYS, 4);
});

test("irrelevant batches never count on the capacity board", () => {
  assert.equal(
    batchCountsOnCapacityBoard(
      { isIrrelevant: true, plantReadyDate: "27-10-2026" },
      { todayYmd: "2026-10-27", plantName: "Tomato" }
    ),
    false
  );
});

test("non-watermelon batches count even when ready is older", () => {
  assert.equal(
    batchCountsOnCapacityBoard(
      { plantReadyDate: "01-09-2026" },
      { todayYmd: "2026-10-27", plantName: "Papaya" }
    ),
    true
  );
});

test("watermelon keeps ready today through today-4 and drops older leftover", () => {
  const today = "2026-10-27";
  const opts = { todayYmd: today, plantName: "Watermelon" };
  assert.equal(batchCountsOnCapacityBoard({ plantReadyDate: "27-10-2026" }, opts), true);
  assert.equal(batchCountsOnCapacityBoard({ plantReadyDate: "23-10-2026" }, opts), true);
  assert.equal(batchCountsOnCapacityBoard({ plantReadyDate: "22-10-2026" }, opts), false);
  assert.equal(batchCountsOnCapacityBoard({ plantReadyDate: "01-10-2026" }, opts), false);
  assert.equal(batchCountsOnCapacityBoard({ plantReadyDate: "01-11-2026" }, opts), true);
  assert.equal(batchCountsOnCapacityBoard({ plantReadyDate: "" }, opts), false);
  assert.equal(
    batchCountsOnCapacityBoard({ plantReadyDate: "22-10-2026" }, { todayYmd: today, plantName: "Ram Tarbuja" }),
    false
  );
});

test("slot excess skips irrelevant and stale watermelon leftovers", () => {
  const batches = [
    { plantsSowed: 10000, orderCoveredPlants: 0, plantReadyDate: "20-10-2026", isIrrelevant: true },
    { plantsSowed: 10000, orderCoveredPlants: 8000, plantReadyDate: "20-10-2026" },
    { plantsSowed: 10000, orderCoveredPlants: 7000, plantReadyDate: "26-10-2026" },
  ];
  const include = (batch) =>
    batchCountsOnCapacityBoard(batch, { todayYmd: "2026-10-27", plantName: "Watermelon" });
  // only the fresh batch: 10000 − 7000 = 3000 (no CMS buffer in this call)
  assert.equal(slotReportedExcess(batches, 0, include), 3000);
  // unfiltered still drops irrelevant, keeps stale + fresh: 2000 + 3000
  assert.equal(slotReportedExcess(batches, 0), 5000);
});

test("board metrics drop stale watermelon excess from free plants", () => {
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
        slotId: "fresh",
        slotStartDay: "26-10-2026",
        slotEndDay: "26-10-2026",
        primarySowed: 10000,
        sowingBatches: [
          { plantsSowed: 10000, orderCoveredPlants: 0, plantReadyDate: "26-10-2026" },
        ],
      },
    ],
    [],
    0,
    { todayYmd: "2026-10-27", plantName: "Watermelon" }
  );
  assert.equal(metrics.get("old").excessAvailableForBooking, 0);
  assert.equal(metrics.get("fresh").excessAvailableForBooking, 10000);
});
