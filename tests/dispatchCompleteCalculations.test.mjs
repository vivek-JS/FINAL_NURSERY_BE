import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  roundMoney,
  getPlantOrderLineTotal,
} from "../utils/farmerPlantOrderLedgerHelper.js";

describe("dispatch complete — payment vs ledger totals", () => {
  it("getPlantOrderLineTotal matches roundMoney(rate * plantCount)", () => {
    const order = { rate: 12.345, numberOfPlants: 100, additionalPlants: 7 };
    const n = 107;
    assert.equal(
      getPlantOrderLineTotal(order),
      roundMoney(order.rate * n)
    );
  });

  it("roundMoney stabilizes dispatch payment comparison inputs", () => {
    const rate = 10.1;
    const qty = 3;
    assert.equal(roundMoney(rate * qty), 30.3);
    assert.equal(roundMoney(30.299999999999997), 30.3);
  });
});

describe("dispatch complete — cumulative returns (FE rule mirror)", () => {
  function maxReturnThisBatch(totalPlants, existingReturned) {
    return Math.max(0, totalPlants - existingReturned);
  }

  it("allows batch when existing + batch <= total", () => {
    assert.equal(maxReturnThisBatch(100, 50), 50);
    assert.ok(40 <= maxReturnThisBatch(100, 50));
  });

  it("caps batch when prior returns consumed headroom", () => {
    assert.equal(maxReturnThisBatch(100, 100), 0);
    assert.equal(maxReturnThisBatch(100, 95), 5);
  });
});
