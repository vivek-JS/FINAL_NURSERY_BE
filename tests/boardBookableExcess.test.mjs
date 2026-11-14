import test from "node:test";
import assert from "node:assert/strict";
import { bookableExcessBySlot, signedBatchFree } from "../utility/boardBookableExcess.js";

test("old sowing is not free, and live cover replaces the stamp", () => {
  const cover = new Map([["SR1", 15000]]);
  assert.equal(
    signedBatchFree(
      { isIrrelevant: true, plantsSowed: 40000, requestNumber: "SR1", orderCoveredPlants: 0 },
      12,
      cover
    ),
    0
  );
  const slots = [
    {
      slotId: "a",
      slotStartDay: "03-11-2026",
      sowingBatches: [
        {
          requestNumber: "SR1",
          plantsSowed: 50652,
          orderCoveredPlants: 27000,
          sowingBufferPct: 12,
        },
      ],
    },
  ];
  const out = bookableExcessBySlot(slots, 12, cover);
  // 50,652 − 12% − 15,000 given. The stamp of 27,000 is not used.
  assert.equal(out.get("a"), 50652 - Math.round(50652 * 0.12) - 15000);
});

test("CMS hold is used when the batch stamp is 10%", () => {
  const cover = new Map([["SR2", 96500]]);
  const free = signedBatchFree(
    { requestNumber: "SR2", plantsSowed: 103068, sowingBufferPct: 10, orderCoveredPlants: 89426 },
    12,
    cover
  );
  assert.equal(free, 103068 - Math.round(103068 * 0.12) - 96500);
});

test("an oversold sowing reduces the other free plants", () => {
  const cover = new Map([
    ["SR-OVER", 96500],
    ["SR-FREE", 0],
  ]);
  const out = bookableExcessBySlot(
    [
      {
        slotId: "early",
        slotStartDay: "09-11-2026",
        sowingBatches: [{ requestNumber: "SR-OVER", plantsSowed: 100000, sowingBufferPct: 12 }],
      },
      {
        slotId: "later",
        slotStartDay: "21-11-2026",
        sowingBatches: [{ requestNumber: "SR-FREE", plantsSowed: 10000, sowingBufferPct: 12 }],
      },
    ],
    12,
    cover
  );
  const over = 100000 - Math.round(100000 * 0.12) - 96500;
  const later = 10000 - Math.round(10000 * 0.12);
  assert.ok(over < 0);
  assert.equal((out.get("early") || 0) + (out.get("later") || 0), later + over);
});

test("explicit 0% hold keeps the whole sowing after orders", () => {
  const cover = new Map([["SR0", 1000]]);
  assert.equal(
    signedBatchFree(
      { requestNumber: "SR0", plantsSowed: 5000, sowingBufferPct: 0, noMortalityReserve: false },
      12,
      cover
    ),
    4000
  );
});
