/**
 * Policy tests for farmer plant order-level payment transfer (cancelled source supported).
 * @see controllers/farmerPlantOrderLedger.controller.js — transferFarmerPlantOrderPayment
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getFarmerPlantPaymentTransitionAction,
  shouldLogFarmerPlantLedger,
} from "../utils/farmerPlantOrderLedgerHelper.js";
import Order from "../models/order.model.js";

describe("farmerPlantOrderPaymentTransfer policy", () => {
  it("COLLECTED → REJECTED is REVERSAL (source side of transfer)", () => {
    assert.equal(getFarmerPlantPaymentTransitionAction("COLLECTED", "REJECTED"), "REVERSAL");
  });

  it("PENDING → COLLECTED is CREDIT (target side of transfer)", () => {
    assert.equal(getFarmerPlantPaymentTransitionAction("PENDING", "COLLECTED"), "CREDIT");
  });

  it("CANCELLED farmer plant order still logs ledger — transfer API does not exclude by orderStatus", () => {
    assert.equal(
      shouldLogFarmerPlantLedger({
        dealerOrder: false,
        farmer: { _id: "507f1f77bcf86cd799439011" },
        orderStatus: "CANCELLED",
      }),
      true
    );
  });

  it("dealer orders do not use farmer plant ledger", () => {
    assert.equal(
      shouldLogFarmerPlantLedger({
        dealerOrder: true,
        farmer: { _id: "507f1f77bcf86cd799439011" },
        orderStatus: "CANCELLED",
      }),
      false
    );
  });

  it("dealer orderFor identity does not make a dealer order eligible for farmer plant ledger", () => {
    assert.equal(
      shouldLogFarmerPlantLedger({
        dealerOrder: true,
        orderFor: { name: "Farmer Customer", mobileNumber: "9876543210" },
      }),
      false
    );
  });

  it("Order payment sub-schema includes transferredFrom trace fields", () => {
    const payPath = Order.schema.path("payment");
    const inner = payPath?.schema;
    assert.ok(inner?.paths?.transferredFromOrderId, "transferredFromOrderId");
    assert.ok(inner?.paths?.transferredFromPaymentId, "transferredFromPaymentId");
  });
});
