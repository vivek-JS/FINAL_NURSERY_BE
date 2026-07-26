import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildQrPaymentCallbackQuery,
  markPaymentBankVerified,
  normalizeQrPaymentCallbackPayload,
  paymentMatchesQrCallback,
} from "../utils/qrPaymentCallback.js";

describe("qrPaymentCallback", () => {
  it("rejects amount-only callbacks", () => {
    const criteria = normalizeQrPaymentCallbackPayload({ amount: 500 });
    assert.equal(criteria.ok, false);
    assert.match(criteria.message, /referenceId or utr/);
  });

  it("rejects zero or negative callback amounts", () => {
    assert.equal(normalizeQrPaymentCallbackPayload({ referenceId: "QR-1", amount: 0 }).ok, false);
    assert.equal(normalizeQrPaymentCallbackPayload({ utr: "UTR1", amount: -1 }).ok, false);
  });

  it("matches pending payment by merchant reference", () => {
    const criteria = normalizeQrPaymentCallbackPayload({ referenceId: "MTID-1" });
    const payment = {
      paymentStatus: "PENDING",
      merchantTranId: "MTID-1",
      paidAmount: 700,
      qrExpiresAt: new Date(Date.now() + 60_000),
    };

    assert.equal(paymentMatchesQrCallback(payment, criteria), true);
  });

  it("does not match by amount without stored UTR identity", () => {
    const criteria = normalizeQrPaymentCallbackPayload({ utr: "BANK-UTR-1", amount: 700 });
    const payment = {
      paymentStatus: "PENDING",
      paidAmount: 700,
      qrExpiresAt: new Date(Date.now() + 60_000),
    };

    assert.equal(paymentMatchesQrCallback(payment, criteria), false);
  });

  it("matches UTR fallback only when UTR and amount both match", () => {
    const criteria = normalizeQrPaymentCallbackPayload({ utr: "BANK-UTR-1", amount: 700 });
    const payment = {
      paymentStatus: "PENDING",
      utrNumber: "BANK-UTR-1",
      paidAmount: 700,
      qrExpiresAt: new Date(Date.now() + 60_000),
    };

    assert.equal(paymentMatchesQrCallback(payment, criteria), true);
  });

  it("marks matching payment bank verified and records UTR", () => {
    const criteria = normalizeQrPaymentCallbackPayload({
      referenceId: "MTID-1",
      utr: "BANK-UTR-1",
    });
    const payment = { paymentStatus: "PENDING", qrReferenceId: "MTID-1", paidAmount: 700 };

    markPaymentBankVerified(payment, criteria);

    assert.equal(payment.paymentStatus, "BANK_VERIFIED");
    assert.equal(payment.transactionId, "BANK-UTR-1");
  });

  it("builds candidate query without amount-only reference gaps", () => {
    const criteria = normalizeQrPaymentCallbackPayload({ utr: "BANK-UTR-1", amount: 700 });
    const query = buildQrPaymentCallbackQuery(criteria);

    assert.equal(query["payment.paymentStatus"], "PENDING");
    assert.equal(query["payment.paidAmount"], 700);
    assert.deepEqual(query.$or, [
      { "payment.transactionId": "BANK-UTR-1" },
      { "payment.utrNumber": "BANK-UTR-1" },
      { "payment.providerTxnId": "BANK-UTR-1" },
      { "payment.bankReferenceNumber": "BANK-UTR-1" },
    ]);
  });
});
