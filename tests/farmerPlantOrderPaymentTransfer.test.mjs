/**
 * Policy tests for farmer plant order-level payment transfer (cancelled source supported).
 * @see controllers/farmerPlantOrderLedger.controller.js — transferFarmerPlantOrderPayment
 * @see utils/farmerPlantOrderLedgerHelper.js — shouldLogFarmerPlantLedger, hasFarmerPlantLedgerIdentity
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getFarmerPlantPaymentTransitionAction,
  hasFarmerPlantLedgerIdentity,
  shouldLogFarmerPlantLedger,
  isDirectOrderPaymentTransfer,
  parseTransferRequestDeductionFromRemark,
} from "../utils/farmerPlantOrderLedgerHelper.js";
import {
  syncDealerLedgerForPaymentStatusTransition,
} from "../utils/dealerLedgerHelper.js";
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

  describe("isDirectOrderPaymentTransfer", () => {
    const sourceOid = "507f1f77bcf86cd799439012";
    const payOid = "507f1f77bcf86cd799439013";

    it("true when transferredFrom fields set and no transferRequestId", () => {
      assert.equal(
        isDirectOrderPaymentTransfer({
          transferredFromOrderId: sourceOid,
          transferredFromPaymentId: payOid,
          paymentStatus: "COLLECTED",
        }),
        true
      );
    });

    it("false when transferRequestId is set (transfer-request flow)", () => {
      assert.equal(
        isDirectOrderPaymentTransfer({
          transferredFromOrderId: sourceOid,
          transferredFromPaymentId: payOid,
          transferRequestId: "507f1f77bcf86cd799439014",
        }),
        false
      );
    });

    it("false without transferredFrom trace", () => {
      assert.equal(isDirectOrderPaymentTransfer({ paymentStatus: "COLLECTED" }), false);
      assert.equal(isDirectOrderPaymentTransfer(null), false);
    });
  });

  it("parseTransferRequestDeductionFromRemark reads approve deduction", () => {
    const reqId = "507f1f77bcf86cd799439014";
    const remark = `[Transfer request #${reqId} approved: -₹1,500 moved to order #1931]`;
    assert.equal(parseTransferRequestDeductionFromRemark(remark, reqId), 1500);
    assert.equal(parseTransferRequestDeductionFromRemark("other", reqId), 0);
  });

  it("updatePaymentStatus routes approved transfer-request reject to undo helper", () => {
    const orderControllerSource = readFileSync(
      resolve(process.cwd(), "controllers/order.controller.js"),
      "utf8"
    );
    assert.match(orderControllerSource, /undoApprovedTransferRequestPayment/);
  });

  it("transferFarmerPlantOrderPayment requires sourceOrderId, targetOrderId, paymentId in body", () => {
    const controllerSource = readFileSync(
      resolve(process.cwd(), "controllers/farmerPlantOrderLedger.controller.js"),
      "utf8"
    );
    assert.match(controllerSource, /const \{ sourceOrderId, targetOrderId, paymentId, message \} = req\.body/);
    assert.match(
      controllerSource,
      /Valid sourceOrderId, targetOrderId, and paymentId are required/
    );
    assert.match(controllerSource, /transferredFromOrderId: new mongoose\.Types\.ObjectId\(sid\)/);
    assert.match(controllerSource, /transferredFromPaymentId: new mongoose\.Types\.ObjectId\(pid\)/);
  });

  describe("syncDealerLedgerForPaymentStatusTransition (transfer-in skip)", () => {
    it("skips COLLECTED on transferred-in payment unless allowTransferIn", async () => {
      const payment = {
        _id: "507f1f77bcf86cd799439015",
        paidAmount: 1000,
        transferredFromOrderId: "507f1f77bcf86cd799439012",
        paymentStatus: "COLLECTED",
      };
      const order = {
        _id: "507f1f77bcf86cd799439016",
        orderId: 2000,
        dealer: "507f1f77bcf86cd799439017",
        payment: [payment],
      };
      const skipped = await syncDealerLedgerForPaymentStatusTransition(
        order,
        payment,
        "PENDING",
        "COLLECTED"
      );
      assert.equal(skipped.action, "SKIP_TRANSFER_IN");
    });
  });
});
