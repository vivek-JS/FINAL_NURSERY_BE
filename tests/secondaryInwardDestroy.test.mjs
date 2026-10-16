import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planSecondaryDestroy,
  summarizeLagwadLines,
} from "../services/secondaryInwardDestroy.service.js";

const line = (over = {}) => ({
  totalQuantity: 1000,
  availableQuantity: 1000,
  destroyedQuantity: 0,
  slotStockSyncedPlants: 900,
  ...over,
});

describe("planSecondaryDestroy", () => {
  it("charges loss to the 10% mortality allowance first", () => {
    const p = planSecondaryDestroy(line(), 60);
    assert.equal(p.fromMortality, 60);
    assert.equal(p.fromSellable, 0);
    assert.equal(p.availAfter, 940);
    assert.equal(p.syncedAfter, 900);
    assert.equal(p.sellableSlotDec, 0);
  });

  it("spills past the allowance into sellable stock", () => {
    const p = planSecondaryDestroy(line({ destroyedQuantity: 80, availableQuantity: 920 }), 50);
    assert.equal(p.fromMortality, 20);
    assert.equal(p.fromSellable, 30);
    assert.equal(p.syncedAfter, 870);
    assert.equal(p.sellableSlotDec, 30);
    assert.equal(p.destroyedAfter, 130);
  });

  it("never leaves more synced than plants physically left", () => {
    const p = planSecondaryDestroy(
      line({ availableQuantity: 100, slotStockSyncedPlants: 90, destroyedQuantity: 100 }),
      95
    );
    assert.equal(p.availAfter, 5);
    assert.equal(p.syncedAfter, 0);
    assert.equal(p.sellableSlotDec, 90);
  });

  it("rejects zero and more than available", () => {
    assert.ok(planSecondaryDestroy(line(), 0).error);
    assert.ok(planSecondaryDestroy(line({ availableQuantity: 10 }), 11).error);
  });
});

describe("summarizeLagwadLines", () => {
  it("gives planted, sold, destroyed and mortality after destroying all remaining", () => {
    const s = summarizeLagwadLines([
      { totalQuantity: 1000, availableQuantity: 0, destroyedQuantity: 150 },
      { totalQuantity: 500, availableQuantity: 0, destroyedQuantity: 50 },
    ]);
    assert.equal(s.gross, 1500);
    assert.equal(s.sold, 1300);
    assert.equal(s.destroyed, 200);
    assert.equal(s.inShed, 0);
    assert.equal(s.mortalityPct, 13.3);
  });

  it("does not count returned plants as planted or sold twice", () => {
    const s = summarizeLagwadLines([
      { totalQuantity: 1000, availableQuantity: 100, destroyedQuantity: 0 },
      { totalQuantity: 50, availableQuantity: 50, destroyedQuantity: 0, isReturn: true },
    ]);
    assert.equal(s.gross, 1000);
    assert.equal(s.returned, 50);
    assert.equal(s.inShed, 150);
    assert.equal(s.sold, 850);
  });
});
