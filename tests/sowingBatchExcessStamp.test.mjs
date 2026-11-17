import test from "node:test";
import assert from "node:assert/strict";
import {
  displaySowingFigures,
  excessFieldsForBatch,
  paintSowingEntryNumbers,
  storedShownExcess,
} from "../utility/sowingBatchExcessStamp.js";

test("noMortalityReserve does not add released mortality on top of sowed", () => {
  const fields = excessFieldsForBatch(
    {
      plantsSowed: 28980,
      orderCoveredPlants: 28000,
      noMortalityReserve: true,
      mortalityMovedToExcess: 2498,
    },
    12
  );
  assert.equal(fields.bufferPlants, 0);
  // 28980 − 28000. The 2498 release is already inside sowed.
  assert.equal(fields.shownExcess, 980);
});

test("noMortalityReserve: full sowed is excess, zero buffer", () => {
  const fields = excessFieldsForBatch(
    { plantsSowed: 25000, orderCoveredPlants: 0, noMortalityReserve: true },
    15
  );
  assert.equal(fields.sowingBufferPct, 0);
  assert.equal(fields.bufferPlants, 0);
  assert.equal(fields.shownExcess, 25000);
});

test("stamps CMS percent of sowed, then subtracts mortality and orders", () => {
  const fields = excessFieldsForBatch(
    { plantsSowed: 75600, orderCoveredPlants: 66700 },
    12
  );
  assert.equal(fields.sowingBufferPct, 12);
  assert.equal(fields.bufferPlants, 9072);
  // 75600 − 9072 − 66700 = −172 → 0
  assert.equal(fields.shownExcess, 0);
});

test("lower live order quantity replaces the saved cover", () => {
  const qty = new Map([
    ["a", 16700],
    ["b", 13000],
    ["c", 18000],
    ["d", 16000],
  ]);
  const fields = excessFieldsForBatch(
    {
      plantsSowed: 75600,
      orderCoveredPlants: 66700,
      linkedOrderIds: ["a", "b", "c", "d"],
    },
    12,
    qty
  );
  assert.equal(fields.bufferPlants, 9072);
  // live cover 63700 → 75600 − 9072 − 63700 = 2828
  assert.equal(fields.shownExcess, 2828);
});

test("a larger linked order list does not replace the saved cover", () => {
  const fields = excessFieldsForBatch(
    { plantsSowed: 89000, orderCoveredPlants: 0, linkedOrderIds: ["a"] },
    15,
    new Map([["a", 122500]])
  );
  assert.equal(fields.bufferPlants, 13350);
  // 89000 − 13350 − 0 = 75650
  assert.equal(fields.shownExcess, 75650);
});

test("entry mortality is 12% of sowed and excess subtracts mortality then orders", () => {
  const figures = displaySowingFigures({
    plantsSowed: 75600,
    orderCoveredPlants: 66700,
    bufferPlants: 9072,
    sowingBufferPct: 12,
    linkedOrders: [{ plants: 16700 }, { plants: 13000 }, { plants: 18000 }, { plants: 16000 }],
  });
  assert.equal(figures.mortality, 9072);
  assert.equal(figures.excess, 2828);
});

test("dispatch excess take lowers the sowing-entry leftover even if farmer list is unchanged", () => {
  const linked = [{ plants: 3700 }];
  const before = displaySowingFigures({
    plantsSowed: 4000,
    orderCoveredPlants: 3700,
    sowingBufferPct: 0,
    linkedOrders: linked,
  });
  const after = displaySowingFigures({
    plantsSowed: 4000,
    orderCoveredPlants: 4000,
    sowingBufferPct: 0,
    linkedOrders: linked,
    excessAllocated: 300,
  });
  assert.equal(before.excess, 300);
  assert.equal(after.excess, 0);
});

test("releasing leftover from the order's own batch raises that entry's excess", () => {
  const after = displaySowingFigures({
    plantsSowed: 4000,
    orderCoveredPlants: 3300,
    sowingBufferPct: 0,
    linkedOrders: [{ plants: 3600 }],
  });
  assert.equal(after.excess, 700);
});

test("stored leftover is sowed minus mortality minus orders", () => {
  assert.equal(
    storedShownExcess({ plantsSowed: 1000, orderCoveredPlants: 0, sowingBufferPct: 12, shownExcess: 880 }),
    880
  );
  assert.equal(
    storedShownExcess({ plantsSowed: 10000, orderCoveredPlants: 8000 }, 12),
    800
  );
});

test("stamped bufferPlants wins when CMS pct is missing (list Excess bug)", () => {
  // UI was showing sowed−cover (3238) because pct arrived as 0; stamped buffer must still apply.
  assert.equal(
    storedShownExcess(
      {
        plantsSowed: 14238,
        orderCoveredPlants: 11000,
        bufferPlants: 1709,
        sowingBufferPct: 12,
      },
      0
    ),
    1529
  );
  assert.equal(
    storedShownExcess(
      {
        plantsSowed: 25000,
        orderCoveredPlants: 0,
        bufferPlants: 3750,
        sowingBufferPct: 15,
      },
      0
    ),
    21250
  );
});

test("paint excess matches dispatch free, not entry-split linked order sums", () => {
  const batch = {
    plantsSowed: 89000,
    orderCoveredPlants: 0,
    sowingBufferPct: 12,
    mortalityMovedToExcess: 0,
  };
  const slot = {};
  const figures = paintSowingEntryNumbers(slot, {
    batch,
    linkedOrders: [{ plants: 5000 }, { plants: 10000 }],
    bufferPct: 12,
    sowed: 89000,
  });
  // 89000 − round(12%) = 89000 − 10680 = 78320
  assert.equal(figures.excess, 78320);
  assert.equal(slot.excessPlants, 78320);
});

test("partial entry rows can hide bookable excess so totals are not double-counted", () => {
  const slot = {};
  const figures = paintSowingEntryNumbers(slot, {
    batch: { plantsSowed: 89000, orderCoveredPlants: 0, sowingBufferPct: 12 },
    bufferPct: 12,
    sowed: 89000,
    showBookableExcess: false,
  });
  assert.equal(figures.excess, 0);
  assert.equal(slot.excessPlants, 0);
});

test("mortality moved into excess stays bookable", () => {
  assert.equal(
    storedShownExcess(
      {
        plantsSowed: 17514,
        orderCoveredPlants: 15000,
        sowingBufferPct: 12,
        bufferPlants: 2102,
        mortalityMovedToExcess: 100,
      },
      12
    ),
    512
  );
});

test("mortality unlock already used in cover is not bookable excess", () => {
  // Candy SR202610180002-style: 12% buffer, unlock 1245 then cover with it
  assert.equal(
    storedShownExcess(
      {
        plantsSowed: 62244,
        orderCoveredPlants: 56020,
        sowingBufferPct: 12,
        bufferPlants: 7469,
        mortalityMovedToExcess: 1245,
      },
      12
    ),
    0
  );
});
