import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  roundMoney,
  getPlantOrderLineTotal,
} from "../utils/farmerPlantOrderLedgerHelper.js";

describe("dispatch complete — payment vs ledger totals", () => {
  it("getPlantOrderLineTotal matches roundMoney(rate * plantCount) when freight is zero", () => {
    const order = { rate: 12.345, numberOfPlants: 100, additionalPlants: 7 };
    const n = 107;
    assert.equal(
      getPlantOrderLineTotal(order),
      roundMoney(order.rate * n)
    );
  });

  it("getPlantOrderLineTotal adds farmer freight share only", () => {
    const order = {
      rate: 10,
      numberOfPlants: 100,
      additionalPlants: 0,
      freight: { totalAmount: 400, farmerShareAmount: 200, companyShareAmount: 200 },
      freightCharges: 200,
    };
    assert.equal(getPlantOrderLineTotal(order), 1200);
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

/**
 * Mirrors recordFarmerPlantLedgerDispatchReturnCredit / DispatchDamagedCredit:
 * credit only when cumulative qty increases (delta > 0).
 */
describe("dispatch complete — ledger plant credits (return & damaged)", () => {
  function ledgerCreditForIncreasedPlants(oldQty, newQty, rateRaw) {
    const oldQ = Number(oldQty) || 0;
    const newQ = Number(newQty) || 0;
    const delta = newQ - oldQ;
    if (delta <= 0) return 0;
    const rate = roundMoney(Number(rateRaw || 0));
    return roundMoney(delta * rate);
  }

  it("credits delta × rate for returns (e.g. 100 plants @ ₹10)", () => {
    assert.equal(ledgerCreditForIncreasedPlants(0, 100, 10), 1000);
  });

  it("uses same formula for damaged deltas", () => {
    assert.equal(ledgerCreditForIncreasedPlants(5, 25, 10), 200);
  });

  it("returns 0 when quantity does not increase", () => {
    assert.equal(ledgerCreditForIncreasedPlants(10, 10, 10), 0);
    assert.equal(ledgerCreditForIncreasedPlants(20, 10, 10), 0);
  });

  it("uses roundMoney on rate and product (controller parity)", () => {
    assert.equal(ledgerCreditForIncreasedPlants(0, 3, 10.1), 30.3);
  });
});

describe("dispatch complete — returned + damaged cap (controller parity)", () => {
  function assertWithinTotal(totalOrdered, existingReturned, existingDamaged, batchReturn, batchDamaged) {
    const totalReturned = existingReturned + batchReturn;
    const totalDamaged = existingDamaged + batchDamaged;
    assert.ok(
      totalReturned + totalDamaged <= totalOrdered,
      `${totalReturned}+${totalDamaged} must not exceed ${totalOrdered}`
    );
  }

  it("allows batch when sum stays at cap", () => {
    assertWithinTotal(100, 30, 20, 40, 10);
  });

  it("rejects over-cap combination", () => {
    assert.throws(() => assertWithinTotal(100, 30, 20, 50, 10));
  });
});
