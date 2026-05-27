/**
 * Policy tests for farmer plant order-level payment transfer (cancelled source supported).
 * @see controllers/farmerPlantOrderLedger.controller.js — transferFarmerPlantOrderPayment
 * @see utils/farmerPlantOrderLedgerHelper.js — shouldLogFarmerPlantLedger, hasFarmerPlantLedgerIdentity
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getFarmerPlantPaymentTransitionAction,
  hasFarmerPlantLedgerIdentity,
  shouldLogFarmerPlantLedger,
} from "../utils/farmerPlantOrderLedgerHelper.js";
import Order from "../models/order.model.js";

const FARMER_ID = "507f1f77bcf86cd799439011";

describe("farmerPlantOrderPaymentTransfer policy", () => {
  describe("getFarmerPlantPaymentTransitionAction", () => {
    it("COLLECTED → REJECTED is REVERSAL (source side of transfer)", () => {
      assert.equal(
        getFarmerPlantPaymentTransitionAction("COLLECTED", "REJECTED"),
        "REVERSAL"
      );
    });

    it("PENDING → COLLECTED is CREDIT (target side of transfer)", () => {
      assert.equal(
        getFarmerPlantPaymentTransitionAction("PENDING", "COLLECTED"),
        "CREDIT"
      );
    });
  });

  describe("hasFarmerPlantLedgerIdentity", () => {
    it("true when farmer ref is present", () => {
      assert.equal(
        hasFarmerPlantLedgerIdentity({ farmer: { _id: FARMER_ID } }),
        true
      );
    });

    it("true when orderFor has a name (dealer booking for end customer)", () => {
      assert.equal(
        hasFarmerPlantLedgerIdentity({ orderFor: { name: "Ram Lal", mobileNumber: "9876543210" } }),
        true
      );
    });

    it("false when no farmer and empty orderFor", () => {
      assert.equal(hasFarmerPlantLedgerIdentity({ dealerOrder: true }), false);
      assert.equal(hasFarmerPlantLedgerIdentity({ orderFor: { name: "  " } }), false);
    });
  });

  describe("shouldLogFarmerPlantLedger", () => {
    it("direct farmer order logs when farmer ref exists (any orderStatus)", () => {
      assert.equal(
        shouldLogFarmerPlantLedger({
          dealerOrder: false,
          farmer: { _id: FARMER_ID },
          orderStatus: "CANCELLED",
        }),
        true
      );
    });

    it("direct farmer order does not log without farmer ref", () => {
      assert.equal(
        shouldLogFarmerPlantLedger({ dealerOrder: false, orderStatus: "ACCEPTED" }),
        false
      );
    });

    it("dealer order logs when end-customer identity exists (farmer ref)", () => {
      assert.equal(
        shouldLogFarmerPlantLedger({
          dealerOrder: true,
          farmer: { _id: FARMER_ID },
          orderStatus: "CANCELLED",
        }),
        true
      );
    });

    it("dealer order logs when end-customer identity exists (orderFor)", () => {
      assert.equal(
        shouldLogFarmerPlantLedger({
          dealerOrder: true,
          orderFor: { name: "End Customer" },
        }),
        true
      );
    });

    it("dealer order without end-customer identity does not log", () => {
      assert.equal(
        shouldLogFarmerPlantLedger({
          dealerOrder: true,
          orderStatus: "ACCEPTED",
        }),
        false
      );
    });

    it("null/undefined order does not log", () => {
      assert.equal(shouldLogFarmerPlantLedger(null), false);
      assert.equal(shouldLogFarmerPlantLedger(undefined), false);
    });
  });

  it("Order payment sub-schema includes transferredFrom trace fields", () => {
    const payPath = Order.schema.path("payment");
    const inner = payPath?.schema;
    assert.ok(inner?.paths?.transferredFromOrderId, "transferredFromOrderId");
    assert.ok(inner?.paths?.transferredFromPaymentId, "transferredFromPaymentId");
  });
});
