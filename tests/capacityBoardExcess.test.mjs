import test from "node:test";
import assert from "node:assert/strict";
import {
  batchCountsOnCapacityBoard,
  futureReadyBoardSlots,
  splitBoardExcessByReady,
} from "../utility/capacityBoardExcess.js";
import { slotReportedExcess } from "../utility/lagwadSlotPlantsSplit.js";
import { computeSowingGapBoardMetricsForSubtype } from "../utility/sowingGapSummaryMetrics.js";

test("irrelevant batches never count on the capacity board", () => {
  assert.equal(batchCountsOnCapacityBoard({ isIrrelevant: true, plantsSowed: 10000 }), false);
  assert.equal(batchCountsOnCapacityBoard({ isIrrelevant: false, plantsSowed: 10000 }), true);
  assert.equal(batchCountsOnCapacityBoard(null), false);
});

test("old sowing entries (ready before lookback) are excluded when today is set", () => {
  const todayYmd = "2026-10-29";
  assert.equal(
    batchCountsOnCapacityBoard(
      { plantReadyDate: "01-09-2026", plantsSowed: 10000, isIrrelevant: false },
      { todayYmd }
    ),
    false
  );
  assert.equal(
    batchCountsOnCapacityBoard(
      { plantReadyDate: "10-10-2026", plantsSowed: 10000, isIrrelevant: false },
      { todayYmd }
    ),
    true
  );
});

test("future-ready free (Prachand-style) is not on the sowing slot", () => {
  const todayYmd = "2026-10-29";
  const include = (b) => batchCountsOnCapacityBoard(b, { todayYmd });
  const { onSlot, byFutureReady } = splitBoardExcessByReady(
    [
      { plantsSowed: 158886, orderCoveredPlants: 0, plantReadyDate: "15-11-2026" },
      { plantsSowed: 10000, orderCoveredPlants: 7000, plantReadyDate: "28-10-2026" },
    ],
    0,
    include,
    todayYmd
  );
  assert.equal(onSlot, 3000);
  assert.equal(byFutureReady.get("2026-11-15"), 158886);
  const cards = futureReadyBoardSlots(byFutureReady, new Map([["2026-11-15", ["slotA"]]]));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].startDay, "15-11-2026");
  assert.equal(cards[0].excess, 158886);
  assert.deepEqual(cards[0].slotIds, ["slotA"]);
});

test("slot excess skips irrelevant and old ready batches", () => {
  const todayYmd = "2026-10-29";
  const include = (b) => batchCountsOnCapacityBoard(b, { todayYmd });
  const batches = [
    { plantsSowed: 10000, orderCoveredPlants: 0, isIrrelevant: true, plantReadyDate: "20-10-2026" },
    { plantsSowed: 10000, orderCoveredPlants: 8000, plantReadyDate: "01-09-2026" },
    { plantsSowed: 10000, orderCoveredPlants: 7000, plantReadyDate: "26-10-2026" },
  ];
  assert.equal(slotReportedExcess(batches, 0, include), 3000);
});

test("free plants keep mortality back and drop irrelevant sowings", () => {
  const todayYmd = "2026-11-13";
  const include = (batch) => batchCountsOnCapacityBoard(batch, { todayYmd });
  const batches = [
    { plantsSowed: 68670, orderCoveredPlants: 44750, sowingBufferPct: 12, isIrrelevant: true, plantReadyDate: "14-10-2026" },
    { plantsSowed: 128142, orderCoveredPlants: 107237, sowingBufferPct: 0, noMortalityReserve: true, plantReadyDate: "30-10-2026" },
    { plantsSowed: 91980, orderCoveredPlants: 63595, sowingBufferPct: 12, plantReadyDate: "09-11-2026" },
    { plantsSowed: 35028, orderCoveredPlants: 30448, sowingBufferPct: 12, plantReadyDate: "15-11-2026" },
  ];
  const { onSlot, byFutureReady } = splitBoardExcessByReady(batches, 12, include, todayYmd);
  // 14 Oct irrelevant is not added (raw leftover would have been 23,920).
  // 30 Oct confirmed count stays 20,905. 9 Nov keeps the 12% hold: 17,347, not 28,385.
  assert.equal(onSlot, 20905 + 17347);
  // 15 Nov is 377 after the 12% hold, not sowed minus orders (4,580).
  assert.equal(byFutureReady.get("2026-11-15"), 377);
});

test("board metrics drop old and irrelevant excess", () => {
  const metrics = computeSowingGapBoardMetricsForSubtype(
    [
      {
        slotId: "fresh",
        slotStartDay: "20-10-2026",
        slotEndDay: "20-10-2026",
        primarySowed: 10000,
        sowingBatches: [
          { plantsSowed: 10000, orderCoveredPlants: 0, plantReadyDate: "20-10-2026" },
        ],
      },
      {
        slotId: "old",
        slotStartDay: "20-09-2026",
        slotEndDay: "20-09-2026",
        primarySowed: 10000,
        sowingBatches: [
          { plantsSowed: 10000, orderCoveredPlants: 0, plantReadyDate: "20-09-2026" },
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
    0,
    { todayYmd: "2026-10-29" }
  );
  assert.equal(metrics.get("fresh").excessAvailableForBooking, 10000);
  assert.equal(metrics.get("old").excessAvailableForBooking, 0);
  assert.equal(metrics.get("skip").excessAvailableForBooking, 0);
});
