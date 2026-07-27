import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePositivePaymentAmount,
  parseQrPaymentCallbackPayload,
} from "../utils/paymentValidation.js";
import { normalizeWatiMobile10 } from "../utility/watiMessaging.js";

test("parsePositivePaymentAmount rejects zero and negative values", () => {
  assert.equal(parsePositivePaymentAmount(0).ok, false);
  assert.equal(parsePositivePaymentAmount(-100).ok, false);
  assert.equal(parsePositivePaymentAmount("100.50").amount, 100.5);
});

test("QR callback payload requires identifier and positive amount", () => {
  assert.equal(parseQrPaymentCallbackPayload({ amount: 5000 }).ok, false);
  assert.equal(parseQrPaymentCallbackPayload({ referenceId: "QR-1" }).ok, false);
  assert.equal(
    parseQrPaymentCallbackPayload({ referenceId: "QR-1", amount: -1 }).ok,
    false
  );

  assert.deepEqual(
    parseQrPaymentCallbackPayload({ referenceId: " QR-1 ", amount: "5000.009" }),
    {
      ok: true,
      referenceId: "QR-1",
      utr: "",
      ref: "QR-1",
      amount: 5000.01,
    }
  );
});

test("WATI mobile normalization rejects ambiguous overlong numbers", () => {
  assert.equal(normalizeWatiMobile10("9876543210"), "9876543210");
  assert.equal(normalizeWatiMobile10("+91 98765 43210"), "9876543210");
  assert.equal(normalizeWatiMobile10("9198765432109999"), "");
});
