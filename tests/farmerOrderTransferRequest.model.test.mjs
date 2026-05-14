import { describe, it } from "node:test";
import assert from "node:assert/strict";
import FarmerOrderTransferRequest from "../models/farmerOrderTransferRequest.model.js";
import Order from "../models/order.model.js";

describe("FarmerOrderTransferRequest schema", () => {
  it("defines expected status lifecycle", () => {
    const statusPath = FarmerOrderTransferRequest.schema.path("status");
    assert.ok(statusPath, "status path exists");
    assert.deepEqual(
      statusPath.enumValues,
      ["PENDING", "APPROVED", "REJECTED", "CANCELLED"]
    );
  });

  it("keeps source and target order references required", () => {
    assert.equal(FarmerOrderTransferRequest.schema.path("fromOrderId").isRequired, true);
    assert.equal(FarmerOrderTransferRequest.schema.path("toOrderId").isRequired, true);
    assert.equal(FarmerOrderTransferRequest.schema.path("requestedAmount").isRequired, true);
  });

  it("tracks posting metadata and ledger transaction id", () => {
    assert.ok(FarmerOrderTransferRequest.schema.path("ledgerTxnId"));
    assert.ok(FarmerOrderTransferRequest.schema.path("postedAt"));
    assert.ok(FarmerOrderTransferRequest.schema.path("postedMetadata.reversalLedgerEntryId"));
    assert.ok(FarmerOrderTransferRequest.schema.path("postedMetadata.paymentLedgerEntryId"));
  });

  it("defaults new documents to PENDING status", () => {
    const doc = new FarmerOrderTransferRequest({
      fromOrderId: "507f1f77bcf86cd799439011",
      toOrderId: "507f1f77bcf86cd799439012",
      requestedAmount: 1200,
      requestedBy: "507f1f77bcf86cd799439013",
    });
    assert.equal(doc.status, "PENDING");
    assert.equal(doc.approval?.approvedBy ?? null, null);
    assert.equal(doc.approval?.rejectedBy ?? null, null);
  });
});

describe("Order payment trace compatibility", () => {
  it("retains transfer trace references in payment sub-schema", () => {
    const payPath = Order.schema.path("payment");
    const paymentSchema = payPath?.schema;
    assert.ok(paymentSchema?.paths?.transferredFromOrderId);
    assert.ok(paymentSchema?.paths?.transferredFromPaymentId);
  });
});
