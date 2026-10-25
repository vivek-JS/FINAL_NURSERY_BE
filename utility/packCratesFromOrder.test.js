import test from "node:test";
import assert from "node:assert/strict";
import {
  packFromOrder,
  packQtyFromOrderDispatchRow,
} from "./packCratesFromOrder.js";

test("1500 @ 126 free=1 → bonus 11, pack 1511, varti 125", () => {
  const p = packFromOrder({
    orderQty: 1500,
    cavitySize: 126,
    numberPerCrate: 1,
    freePlantsPerCrate: 1,
  });
  assert.equal(p.orderQty, 1500);
  assert.equal(p.fullCratesPass1, 11);
  assert.equal(p.bonus, 11);
  assert.equal(p.packQty, 1511);
  assert.equal(p.crateCount, 12);
  assert.equal(p.plantCount, 1511);
  assert.deepEqual(p.crateDetails, [
    { crateCount: 11, plantCount: 1386 },
    { crateCount: 1, plantCount: 125 },
  ]);
});

test("exact full crates 1260 @ 126 free=1 → pack 1270", () => {
  const p = packFromOrder({
    orderQty: 1260,
    cavitySize: 126,
    numberPerCrate: 1,
    freePlantsPerCrate: 1,
  });
  assert.equal(p.bonus, 10);
  assert.equal(p.packQty, 1270);
  assert.deepEqual(p.crateDetails, [
    { crateCount: 10, plantCount: 1260 },
    { crateCount: 1, plantCount: 10 },
  ]);
});

test("free=0 unchanged from order qty", () => {
  const p = packFromOrder({
    orderQty: 1500,
    cavitySize: 126,
    numberPerCrate: 1,
    freePlantsPerCrate: 0,
  });
  assert.equal(p.bonus, 0);
  assert.equal(p.packQty, 1500);
  assert.deepEqual(p.crateDetails, [
    { crateCount: 11, plantCount: 1386 },
    { crateCount: 1, plantCount: 114 },
  ]);
});

test("DC stays on orderQty — packQtyFromOrderDispatchRow prefers crate plantCount", () => {
  const row = {
    dispatchQuantity: 1500,
    crates: [
      {
        plantCount: 1511,
        crateDetails: [
          { crateCount: 11, plantCount: 1386 },
          { crateCount: 1, plantCount: 125 },
        ],
      },
    ],
  };
  assert.equal(packQtyFromOrderDispatchRow(row), 1511);
  assert.equal(row.dispatchQuantity, 1500);
});
