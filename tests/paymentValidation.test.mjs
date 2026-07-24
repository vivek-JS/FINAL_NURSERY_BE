import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeQrPaymentCallbackPayload,
  parsePositivePaymentAmount,
} from "../utils/paymentValidation.js";

test("parsePositivePaymentAmount accepts finite positive money values", () => {
  assert.deepEqual(parsePositivePaymentAmount("100.126", "paidAmount"), {
    ok: true,
    amount: 100.13,
  });
});

test("parsePositivePaymentAmount rejects zero, negative, and non-finite values", () => {
  assert.equal(parsePositivePaymentAmount(0, "paidAmount").ok, false);
  assert.equal(parsePositivePaymentAmount(-100, "paidAmount").ok, false);
  assert.equal(parsePositivePaymentAmount("x", "paidAmount").ok, false);
});

test("normalizeQrPaymentCallbackPayload rejects amount-only callbacks", () => {
  const parsed = normalizeQrPaymentCallbackPayload({ amount: 5000 });
  assert.equal(parsed.ok, false);
});

test("normalizeQrPaymentCallbackPayload requires positive amount with utr-only callbacks", () => {
  assert.equal(
    normalizeQrPaymentCallbackPayload({ utr: "UTR123" }).ok,
    false
  );
  assert.equal(
    normalizeQrPaymentCallbackPayload({ utr: "UTR123", amount: -1 }).ok,
    false
  );
  assert.deepEqual(
    normalizeQrPaymentCallbackPayload({ utr: "UTR123", amount: "10" }),
    { ok: true, reference: "UTR123", utr: "UTR123", amount: 10 }
  );
});

test("normalizeQrPaymentCallbackPayload accepts referenceId with optional positive amount", () => {
  assert.deepEqual(
    normalizeQrPaymentCallbackPayload({ referenceId: " QR-1 ", amount: "99.995" }),
    { ok: true, reference: "QR-1", utr: "", amount: 100 }
  );
});
