import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeOrderCommissionMetrics,
  ACTUAL_COMMISSION_STATUSES,
  splitCommissionAmount,
} from "../services/dealerCommission.service.js";

const plantNames = new Map([["plant1", "Banana"]]);
const subtypeNames = new Map([["st1", "G9"]]);
const ratesMap = new Map([["plant1_st1", 1]]);

function baseOrder(overrides = {}) {
  return {
    orderId: 252601799,
    orderStatus: "DISPATCHED",
    numberOfPlants: 100,
    additionalPlants: 0,
    remainingPlants: 0,
    returnedPlants: 0,
    damagedPlants: 0,
    rate: 10,
    plantName: "plant1",
    plantSubtype: "st1",
    payment: [{ paymentStatus: "COLLECTED", paidAmount: 1000 }],
    orderPaymentStatus: "COMPLETED",
    paymentCompleted: true,
    dispatchHistory: [],
    orderFor: { name: "Kiran chaudhari", village: "Abit Khind" },
    farmer: null,
    ...overrides,
  };
}

describe("dealerCommission", () => {
  it("includes DISPATCHED in actual commission statuses", () => {
    assert.ok(ACTUAL_COMMISSION_STATUSES.has("DISPATCHED"));
  });

  it("counts positive actual commission for fully dispatched, paid DISPATCHED order", () => {
    const metrics = computeOrderCommissionMetrics(
      baseOrder(),
      ratesMap,
      plantNames,
      subtypeNames
    );
    assert.equal(metrics.dispatched, 100);
    assert.equal(metrics.finalPlants, 100);
    assert.equal(metrics.actualCommission, 100);
    assert.equal(metrics.earnedCommission, 100);
    assert.equal(metrics.atRiskCommission, 0);
    assert.equal(metrics.isPaymentComplete, true);
  });

  it("counts negative actual commission for DISPATCHED order with payment pending", () => {
    const metrics = computeOrderCommissionMetrics(
      baseOrder({
        payment: [],
        orderPaymentStatus: "PENDING",
        paymentCompleted: false,
      }),
      ratesMap,
      plantNames,
      subtypeNames
    );
    assert.equal(metrics.actualCommission, -100);
    assert.equal(metrics.earnedCommission, 0);
    assert.equal(metrics.atRiskCommission, 100);
    assert.equal(metrics.unpaidLiability, 100);
  });

  it("splitCommissionAmount separates earned and at-risk", () => {
    assert.deepEqual(splitCommissionAmount(50), { earnedCommission: 50, atRiskCommission: 0 });
    assert.deepEqual(splitCommissionAmount(-30), { earnedCommission: 0, atRiskCommission: 30 });
    assert.deepEqual(splitCommissionAmount(0), { earnedCommission: 0, atRiskCommission: 0 });
  });

  it("does not count actual commission before dispatch (ACCEPTED)", () => {
    const metrics = computeOrderCommissionMetrics(
      baseOrder({
        orderStatus: "ACCEPTED",
        remainingPlants: 100,
      }),
      ratesMap,
      plantNames,
      subtypeNames
    );
    assert.equal(metrics.actualCommission, 0);
    assert.equal(metrics.expectedCommission, 100);
  });
});
