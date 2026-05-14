import test from "node:test";
import assert from "node:assert/strict";
import {
  projectProvisionalBalanceAmount,
  orderRequiresRamAgriOutstandingLimit,
} from "../services/ramAgriOutstanding.service.js";

test("projectProvisionalBalanceAmount single-line", () => {
  const doc = {
    orderStatus: "ACCEPTED",
    quantity: 2,
    rate: 100,
    payment: [{ paidAmount: 50, paymentStatus: "COLLECTED" }],
  };
  const bal = projectProvisionalBalanceAmount(doc);
  assert.equal(bal, 150);
});

test("projectProvisionalBalanceAmount multi-line rollup", () => {
  const doc = {
    orderStatus: "ACCEPTED",
    lineItems: [
      { productName: "A", quantity: 1, rate: 10, isRamAgriProduct: true },
      { productName: "B", quantity: 2, rate: 5, isRamAgriProduct: true },
    ],
    payment: [],
  };
  const bal = projectProvisionalBalanceAmount(doc);
  assert.equal(bal, 20);
});

test("orderRequiresRamAgriOutstandingLimit detects Ram Agri line", () => {
  assert.equal(
    orderRequiresRamAgriOutstandingLimit({
      lineItems: [{ isRamAgriProduct: true, quantity: 1, rate: 1 }],
    }),
    true
  );
  assert.equal(
    orderRequiresRamAgriOutstandingLimit({
      isRamAgriProduct: false,
      productId: "507f1f77bcf86cd799439011",
      quantity: 1,
      rate: 1,
    }),
    false
  );
});
