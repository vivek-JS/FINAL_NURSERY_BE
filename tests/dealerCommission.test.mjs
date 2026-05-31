import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeOrderCommissionMetrics,
  ACTUAL_COMMISSION_STATUSES,
  EXPECTED_COMMISSION_STATUSES,
  orderQualifiesForExpectedCommission,
  COMMISSION_REVENUE_STATUSES,
  splitCommissionAmount,
  getCommissionRateForOrder,
  isDealerUser,
} from "../services/dealerCommission.service.js";

const plantNames = new Map([["plant1", "Banana"]]);
const subtypeNames = new Map([["st1", "G9"]]);
const ratesMap = new Map([["plant1_st1", 1]]);

function baseOrder(overrides = {}) {
  return {
    orderId: 252601799,
    orderStatus: "COMPLETED",
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
  it("recognizes actual commission only on COMPLETED / PARTIALLY_COMPLETED", () => {
    assert.ok(ACTUAL_COMMISSION_STATUSES.has("COMPLETED"));
    assert.ok(ACTUAL_COMMISSION_STATUSES.has("PARTIALLY_COMPLETED"));
    assert.ok(!ACTUAL_COMMISSION_STATUSES.has("DISPATCHED"));
    assert.ok(!ACTUAL_COMMISSION_STATUSES.has("READY_FOR_DISPATCH"));
    assert.equal(COMMISSION_REVENUE_STATUSES, ACTUAL_COMMISSION_STATUSES);
  });

  it("expected commission from ACCEPTED through dispatch and complete (booked qty)", () => {
    assert.ok(EXPECTED_COMMISSION_STATUSES.has("ACCEPTED"));
    assert.ok(EXPECTED_COMMISSION_STATUSES.has("READY_FOR_DISPATCH"));
    assert.ok(EXPECTED_COMMISSION_STATUSES.has("DISPATCHED"));
    assert.ok(EXPECTED_COMMISSION_STATUSES.has("COMPLETED"));
    assert.ok(!EXPECTED_COMMISSION_STATUSES.has("PENDING"));
    assert.ok(orderQualifiesForExpectedCommission({ orderStatus: "DISPATCHED" }));
    assert.ok(!orderQualifiesForExpectedCommission({ orderStatus: "PENDING" }));
  });

  it("counts positive actual commission for fully completed, paid order", () => {
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
    assert.equal(metrics.recognizedRevenue, 1000);
  });

  it("counts negative actual commission for COMPLETED order with payment pending", () => {
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

  it("keeps expected on READY_FOR_DISPATCH but no actual until complete", () => {
    const metrics = computeOrderCommissionMetrics(
      baseOrder({
        orderStatus: "READY_FOR_DISPATCH",
        remainingPlants: 100,
      }),
      ratesMap,
      plantNames,
      subtypeNames
    );
    assert.equal(metrics.actualCommission, 0);
    assert.equal(metrics.recognizedRevenue, 0);
    assert.equal(metrics.expectedCommission, 100);
  });

  it("keeps expected on DISPATCHED (booked qty) without actual until complete", () => {
    const metrics = computeOrderCommissionMetrics(
      baseOrder({
        orderStatus: "DISPATCHED",
        remainingPlants: 0,
        returnedPlants: 10,
      }),
      ratesMap,
      plantNames,
      subtypeNames
    );
    assert.equal(metrics.expectedCommission, 100);
    assert.equal(metrics.actualCommission, 0);
    assert.equal(metrics.recognizedRevenue, 0);
    assert.equal(metrics.earnedCommission, 0);
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

  it("calculates commission as ratePerPlant × net delivered quantity", () => {
    const metrics = computeOrderCommissionMetrics(
      baseOrder({
        numberOfPlants: 100,
        remainingPlants: 50,
        dispatchHistory: [{ quantity: 50 }],
        commissionRatePerPlant: 2,
      }),
      ratesMap,
      plantNames,
      subtypeNames
    );
    assert.equal(metrics.deliveredQuantity, 50);
    assert.equal(metrics.netDeliveredQuantity, 50);
    assert.equal(metrics.commissionAmount, 100);
    assert.equal(metrics.actualCommission, 100);
  });

  it("reduces commission for returns on delivered plants", () => {
    const metrics = computeOrderCommissionMetrics(
      baseOrder({
        numberOfPlants: 100,
        remainingPlants: 0,
        returnedPlants: 10,
        commissionRatePerPlant: 2,
      }),
      ratesMap,
      plantNames,
      subtypeNames
    );
    assert.equal(metrics.deliveredQuantity, 100);
    assert.equal(metrics.netDeliveredQuantity, 90);
    assert.equal(metrics.commissionAmount, 180);
    assert.equal(metrics.actualCommission, 180);
  });

  it("uses snapshotted commissionRatePerPlant over live ratesMap", () => {
    const order = baseOrder({ commissionRatePerPlant: 3 });
    assert.equal(getCommissionRateForOrder(order, ratesMap), 3);

    const metrics = computeOrderCommissionMetrics(
      order,
      ratesMap,
      plantNames,
      subtypeNames
    );
    assert.equal(metrics.ratePerPlant, 3);
    assert.equal(metrics.actualCommission, 300);
    assert.equal(metrics.earnedCommission, 300);
  });

  it("falls back to ratesMap when commissionRatePerPlant is not set", () => {
    const order = baseOrder();
    assert.equal(getCommissionRateForOrder(order, ratesMap), 1);
  });

  it("isDealerUser detects dealer by jobTitle or role", () => {
    assert.equal(isDealerUser({ jobTitle: "DEALER" }), true);
    assert.equal(isDealerUser({ role: "DEALER" }), true);
    assert.equal(isDealerUser({ jobTitle: "SALES", role: "SALES" }), false);
    assert.equal(isDealerUser(null), false);
  });
});
