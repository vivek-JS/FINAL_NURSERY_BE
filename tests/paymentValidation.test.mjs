import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePositiveAmount,
  normalizeQrPaymentCallback,
  qrPaymentSubdocMatches,
} from "../utils/paymentValidation.js";

describe("paymentValidation", () => {
  it("requires positive finite payment amounts", () => {
    assert.equal(normalizePositiveAmount("10.50"), 10.5);
    assert.equal(normalizePositiveAmount(0), null);
    assert.equal(normalizePositiveAmount(-1), null);
    assert.equal(normalizePositiveAmount("abc"), null);
  });

  it("rejects QR callbacks without both identity and positive amount", () => {
    assert.deepEqual(normalizeQrPaymentCallback({ amount: 500 }), {
      ok: false,
      message: "referenceId or utr required",
    });
    assert.deepEqual(normalizeQrPaymentCallback({ referenceId: "QR-1" }), {
      ok: false,
      message: "amount must be greater than 0",
    });
    assert.deepEqual(normalizeQrPaymentCallback({ referenceId: "QR-1", amount: -1 }), {
      ok: false,
      message: "amount must be greater than 0",
    });
  });

  it("matches QR payment rows by stored identity and amount together", () => {
    const callback = normalizeQrPaymentCallback({ referenceId: "QR-1", amount: "500.00" });
    assert.equal(callback.ok, true);

    assert.equal(
      qrPaymentSubdocMatches(
        {
          paymentStatus: "PENDING",
          qrReferenceId: "QR-1",
          paidAmount: 500,
          qrExpiresAt: new Date(Date.now() + 60_000),
        },
        callback
      ),
      true
    );
    assert.equal(
      qrPaymentSubdocMatches(
        {
          paymentStatus: "PENDING",
          qrReferenceId: "QR-1",
          paidAmount: 501,
        },
        callback
      ),
      false
    );
  });

  it("requires UTR callbacks to match a stored payment UTR or transaction id", () => {
    const callback = normalizeQrPaymentCallback({ utr: "UTR-123", amount: 500 });
    assert.equal(callback.ok, true);

    assert.equal(
      qrPaymentSubdocMatches(
        {
          paymentStatus: "PENDING",
          paidAmount: 500,
        },
        callback
      ),
      false
    );
    assert.equal(
      qrPaymentSubdocMatches(
        {
          paymentStatus: "PENDING",
          transactionId: "UTR-123",
          paidAmount: 500,
        },
        callback
      ),
      true
    );
  });
});
