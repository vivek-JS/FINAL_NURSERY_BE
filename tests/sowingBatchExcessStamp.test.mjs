import test from "node:test";
import assert from "node:assert/strict";
import { displaySowingFigures, excessFieldsForBatch, storedShownExcess } from "../utility/sowingBatchExcessStamp.js";

test("stamps CMS percent of sowed, then subtracts orders", () => {
  const fields = excessFieldsForBatch(
    { plantsSowed: 75600, orderCoveredPlants: 66700 },
    12
  );
  assert.equal(fields.sowingBufferPct, 12);
  assert.equal(fields.bufferPlants, 9072);
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
  assert.equal(fields.shownExcess, 2828);
});

test("a larger linked order list does not replace the saved cover", () => {
  const fields = excessFieldsForBatch(
    { plantsSowed: 89000, orderCoveredPlants: 0, linkedOrderIds: ["a"] },
    15,
    new Map([["a", 122500]])
  );
  assert.equal(fields.bufferPlants, 13350);
  assert.equal(fields.shownExcess, 75650);
});

test("entry mortality is 12% of sowed and excess subtracts the lower order total", () => {
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

test("stored shownExcess is read back as saved", () => {
  assert.equal(
    storedShownExcess({ plantsSowed: 75600, orderCoveredPlants: 66700, sowingBufferPct: 12, shownExcess: 0 }),
    0
  );
  assert.equal(
    storedShownExcess({ plantsSowed: 10000, orderCoveredPlants: 8000 }, 12),
    800
  );
});
