import test from "node:test";
import assert from "node:assert/strict";
import { storedShownExcess, dispatchBookableFree } from "../utility/sowingBatchExcessStamp.js";
import { sowBatchStock } from "../utility/lagwadSlotPlantsSplit.js";
import { excessReadyInWindow } from "../utility/excessCoverWindow.js";

/** Ganraj_555 ready 11-11-2026: leftover is held as mortality, but sowing shows excess. */
const ganraj11Nov = {
  plantsSowed: 17514,
  orderCoveredPlants: 15000,
  destroyedPlants: 0,
  shownExcess: 512,
  sowingBufferPct: 12,
  bufferPlants: 2102,
  mortalityMovedToExcess: 100,
  isIrrelevant: false,
};

test("sowing shown excess excludes CMS mortality then adds mortality moved", () => {
  assert.equal(sowBatchStock(ganraj11Nov).free, 0);
  // 17514 − 2102 − 15000 + 100 = 512
  assert.equal(storedShownExcess(ganraj11Nov, 12), 512);
  assert.equal(dispatchBookableFree(ganraj11Nov), 512);
});

test("unstamped batch still counts mortality moved into excess", () => {
  const unstamped = {
    plantsSowed: 17514,
    orderCoveredPlants: 15000,
    mortalityMovedToExcess: 100,
  };
  // buffer = round(17514 * 12%) = 2102 → 17514 − 2102 − 15000 + 100 = 512
  assert.equal(storedShownExcess(unstamped, 12), 512);
});

test("default −12 / +3 window; wider past only when pastCap passed", () => {
  assert.equal(excessReadyInWindow(0, 3, 12), true);
  assert.equal(excessReadyInWindow(-2, 3, 12), true);
  assert.equal(excessReadyInWindow(-12, 3, 12), true);
  assert.equal(excessReadyInWindow(-13, 3, 12), false);
  assert.equal(excessReadyInWindow(3, 3, 12), true);
  assert.equal(excessReadyInWindow(4, 3, 12), false);
  assert.equal(excessReadyInWindow(-10, 5), false); // symmetric default pastCap=win
  assert.equal(excessReadyInWindow(-10, 5, 45), true);
  assert.equal(excessReadyInWindow(-46, 5, 45), false);
});
