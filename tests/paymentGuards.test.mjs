import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildQrPaymentCallbackQuery,
  normalizeQrPaymentCallbackInput,
  parsePositivePaymentAmount,
  qrPaymentMatchesCallback,
} from "../utils/paymentGuards.js";

describe("paymentGuards", () => {
  it("accepts only finite positive payment amounts", () => {
    assert.equal(parsePositivePaymentAmount("10.5"), 10.5);
    assert.equal(parsePositivePaymentAmount(0), null);
    assert.equal(parsePositivePaymentAmount("-1"), null);
    assert.equal(parsePositivePaymentAmount("abc"), null);
    assert.equal(parsePositivePaymentAmount(Infinity), null);
  });

  it("requires a QR callback reference value and positive amount", () => {
    assert.equal(normalizeQrPaymentCallbackInput({ amount: 500 }).isValid, false);
    assert.equal(normalizeQrPaymentCallbackInput({ referenceId: "QR-1" }).isValid, false);
    assert.equal(
      normalizeQrPaymentCallbackInput({ referenceId: "QR-1", amount: 0 }).isValid,
      false
    );

    const input = normalizeQrPaymentCallbackInput({
      referenceId: " QR-1 ",
      utr: " UTR-1 ",
      amount: "500.004",
    });

    assert.equal(input.isValid, true);
    assert.equal(input.ref, "QR-1");
    assert.equal(input.utr, "UTR-1");
    assert.equal(input.amount, 500);
  });

  it("builds QR callback lookup with reference and amount", () => {
    assert.deepEqual(
      buildQrPaymentCallbackQuery({ ref: "QR-1", amount: 500 }),
      {
        "payment.paymentStatus": "PENDING",
        "payment.qrReferenceId": "QR-1",
        "payment.paidAmount": 500,
      }
    );
  });

  it("matches only pending, unexpired QR payments by reference and amount", () => {
    const input = normalizeQrPaymentCallbackInput({ referenceId: "QR-1", amount: 500 });
    const now = new Date("2026-01-01T00:00:00.000Z");

    assert.equal(
      qrPaymentMatchesCallback(
        {
          paymentStatus: "PENDING",
          qrReferenceId: "QR-1",
          paidAmount: 500,
          qrExpiresAt: new Date("2026-01-01T00:01:00.000Z"),
        },
        input,
        now
      ),
      true
    );

    assert.equal(
      qrPaymentMatchesCallback(
        { paymentStatus: "PENDING", qrReferenceId: "QR-2", paidAmount: 500 },
        input,
        now
      ),
      false
    );
    assert.equal(
      qrPaymentMatchesCallback(
        { paymentStatus: "PENDING", qrReferenceId: "QR-1", paidAmount: 501 },
        input,
        now
      ),
      false
    );
    assert.equal(
      qrPaymentMatchesCallback(
        {
          paymentStatus: "PENDING",
          qrReferenceId: "QR-1",
          paidAmount: 500,
          qrExpiresAt: new Date("2025-12-31T23:59:59.000Z"),
        },
        input,
        now
      ),
      false
    );
  });
});
