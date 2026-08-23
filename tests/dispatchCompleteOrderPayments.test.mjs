/**
 * Unit tests for dispatch-complete optional payments (handleDispatchReturns payload).
 * @see utils/dispatchCompleteOrderPayments.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import AppError from "../utility/appError.js";
import {
  applyWalletForDispatchNewPayments,
  buildDispatchCompletePaymentSubdocs,
  formatOrderWalletDescriptionContext,
  sumCollectedFromNewPaymentSubdocs,
} from "../utils/dispatchCompleteOrderPayments.js";

describe("dispatchCompleteOrderPayments — formatOrderWalletDescriptionContext", () => {
  it("formats dealer order", () => {
    assert.equal(formatOrderWalletDescriptionContext({ dealerOrder: true }), "Dealer Order");
  });

  it("formats farmer name and village", () => {
    const s = formatOrderWalletDescriptionContext({
      dealerOrder: false,
      farmer: { name: "Sita", village: "Nandurbar" },
    });
    assert.equal(s, "Sita (Nandurbar)");
  });

  it("falls back when farmer missing", () => {
    assert.equal(formatOrderWalletDescriptionContext({ dealerOrder: false }), "Unknown Customer");
  });
});

describe("dispatchCompleteOrderPayments — buildDispatchCompletePaymentSubdocs", () => {
  const farmerOrder = {
    dealerOrder: false,
    farmer: { name: "Ram", village: "Akkalkuwa" },
  };

  it("returns empty array for null, undefined, or empty list", () => {
    assert.deepEqual(buildDispatchCompletePaymentSubdocs(null, {}, farmerOrder), []);
    assert.deepEqual(buildDispatchCompletePaymentSubdocs(undefined, {}, farmerOrder), []);
    assert.deepEqual(buildDispatchCompletePaymentSubdocs([], {}, farmerOrder), []);
  });

  it("normalizes wallet payment and sets mode Wallet", () => {
    const [row] = buildDispatchCompletePaymentSubdocs(
      [{ paidAmount: 500, isWalletPayment: true, paymentStatus: "COLLECTED" }],
      { jobTitle: "ACCOUNTANT" },
      farmerOrder
    );
    assert.equal(row.paidAmount, 500);
    assert.equal(row.paymentStatus, "COLLECTED");
    assert.equal(row.modeOfPayment, "Wallet");
    assert.equal(row.isWalletPayment, true);
    assert.equal(row.customerName, "Ram");
  });

  it("allows SUPERADMIN to set COLLECTED", () => {
    const [row] = buildDispatchCompletePaymentSubdocs(
      [{ paidAmount: 200, modeOfPayment: "UPI", paymentStatus: "COLLECTED" }],
      { role: "SUPERADMIN" },
      farmerOrder
    );
    assert.equal(row.paymentStatus, "COLLECTED");
    assert.equal(row.modeOfPayment, "UPI");
  });

  it("forces PENDING for OFFICE_ADMIN even when COLLECTED requested", () => {
    const [row] = buildDispatchCompletePaymentSubdocs(
      [{ paidAmount: 100, modeOfPayment: "Cash", paymentStatus: "COLLECTED" }],
      { jobTitle: "OFFICE_ADMIN" },
      farmerOrder
    );
    assert.equal(row.paymentStatus, "PENDING");
  });

  it("throws AppError when non-wallet payment has no mode", () => {
    assert.throws(
      () =>
        buildDispatchCompletePaymentSubdocs(
          [{ paidAmount: 100, isWalletPayment: false }],
          { jobTitle: "ACCOUNTANT" },
          farmerOrder
        ),
      (err) => err instanceof AppError && err.statusCode === 400
    );
  });

  it("throws AppError for NaN or zero amount", () => {
    assert.throws(
      () =>
        buildDispatchCompletePaymentSubdocs(
          [{ paidAmount: 0, isWalletPayment: true }],
          { jobTitle: "ACCOUNTANT" },
          farmerOrder
        ),
      (err) => err instanceof AppError
    );
    assert.throws(
      () =>
        buildDispatchCompletePaymentSubdocs(
          [{ paidAmount: "x", isWalletPayment: true }],
          { jobTitle: "ACCOUNTANT" },
          farmerOrder
        ),
      (err) => err instanceof AppError
    );
  });

  it("normalizes Discount rows as pending concession without bank fields", () => {
    const [row] = buildDispatchCompletePaymentSubdocs(
      [
        {
          paidAmount: 250,
          modeOfPayment: "Discount",
          isDiscount: true,
          paymentStatus: "COLLECTED",
          remark: "Festival concession",
        },
      ],
      { jobTitle: "OFFICE_ADMIN" },
      farmerOrder
    );
    assert.equal(row.modeOfPayment, "Discount");
    assert.equal(row.isDiscount, true);
    assert.equal(row.paymentStatus, "PENDING");
    assert.equal(row.isWalletPayment, false);
    assert.equal(row.bankVerificationStatus, "NOT_REQUIRED");
    assert.equal(row.remark, "Festival concession");
  });

  it("rejects Discount as a wallet payment", () => {
    assert.throws(
      () =>
        buildDispatchCompletePaymentSubdocs(
          [{ paidAmount: 100, modeOfPayment: "Discount", isWalletPayment: true }],
          { jobTitle: "ACCOUNTANT" },
          farmerOrder
        ),
      (err) => err instanceof AppError && err.statusCode === 400
    );
  });

  it("trims utrNumber and maps to transactionId", () => {
    const [row] = buildDispatchCompletePaymentSubdocs(
      [
        {
          paidAmount: 50,
          isWalletPayment: true,
          utrNumber: "  UTR123  ",
        },
      ],
      { jobTitle: "ACCOUNTANT" },
      farmerOrder
    );
    assert.equal(row.utrNumber, "UTR123");
    assert.equal(row.transactionId, "UTR123");
  });
});

describe("dispatchCompleteOrderPayments — sumCollectedFromNewPaymentSubdocs", () => {
  it("sums only COLLECTED rows", () => {
    assert.equal(
      sumCollectedFromNewPaymentSubdocs([
        { paidAmount: 100, paymentStatus: "COLLECTED" },
        { paidAmount: 40, paymentStatus: "PENDING" },
        { paidAmount: 2.5, paymentStatus: "COLLECTED" },
      ]),
      102.5
    );
  });

  it("treats null or empty as zero", () => {
    assert.equal(sumCollectedFromNewPaymentSubdocs(null), 0);
    assert.equal(sumCollectedFromNewPaymentSubdocs(undefined), 0);
    assert.equal(sumCollectedFromNewPaymentSubdocs([]), 0);
  });
});

describe("dispatchCompleteOrderPayments — applyWalletForDispatchNewPayments", () => {
  it("no-ops when normalizedSubdocs empty", async () => {
    await applyWalletForDispatchNewPayments(
      { _id: "507f1f77bcf86cd799439011", dealerOrder: false },
      [],
      "Farmer",
      null,
      null
    );
  });
});
