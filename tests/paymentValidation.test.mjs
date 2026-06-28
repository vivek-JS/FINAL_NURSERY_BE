import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePositivePaymentAmount,
  parseQrPaymentCallbackPayload,
} from "../utils/paymentValidation.js";

describe("paymentValidation", () => {
  describe("parsePositivePaymentAmount", () => {
    it("accepts positive numeric input and rounds to cents", () => {
      assert.equal(parsePositivePaymentAmount("123.456"), 123.46);
    });

    it("rejects zero, negative, and non-numeric amounts", () => {
      assert.equal(parsePositivePaymentAmount(0), null);
      assert.equal(parsePositivePaymentAmount("-10"), null);
      assert.equal(parsePositivePaymentAmount("not-a-number"), null);
    });
  });

  describe("parseQrPaymentCallbackPayload", () => {
    it("accepts a referenceId without requiring amount", () => {
      const parsed = parseQrPaymentCallbackPayload({ referenceId: "  MTID-123  " });
      assert.equal(parsed.ok, true);
      assert.equal(parsed.ref, "MTID-123");
      assert.equal(parsed.amount, null);
    });

    it("accepts utr only when paired with a positive amount", () => {
      const parsed = parseQrPaymentCallbackPayload({ utr: " UTR-9 ", amount: "5000" });
      assert.equal(parsed.ok, true);
      assert.equal(parsed.ref, "UTR-9");
      assert.equal(parsed.amount, 5000);
    });

    it("rejects amount-only callbacks to avoid matching arbitrary pending payments", () => {
      const parsed = parseQrPaymentCallbackPayload({ amount: "5000" });
      assert.equal(parsed.ok, false);
      assert.equal(parsed.status, 400);
    });

    it("rejects invalid callback amounts", () => {
      assert.equal(parseQrPaymentCallbackPayload({ referenceId: "MTID", amount: 0 }).ok, false);
      assert.equal(parseQrPaymentCallbackPayload({ utr: "UTR", amount: -1 }).ok, false);
      assert.equal(parseQrPaymentCallbackPayload({ utr: "UTR" }).ok, false);
    });
  });
});
