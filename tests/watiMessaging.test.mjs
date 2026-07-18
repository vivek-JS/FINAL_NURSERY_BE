import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWatiSendRecipient,
  normalizeWatiMobile10,
  resolveWatiSendMobile,
} from "../utility/watiMessaging.js";

describe("watiMessaging recipient normalization", () => {
  it("accepts 10-digit numbers and 91-prefixed Indian numbers", () => {
    assert.equal(normalizeWatiMobile10("9876543210"), "9876543210");
    assert.equal(normalizeWatiMobile10("+91 98765 43210"), "9876543210");
  });

  it("rejects ambiguous overlong numbers instead of slicing the last 10 digits", () => {
    assert.equal(normalizeWatiMobile10("123459876543210"), "");
    assert.equal(resolveWatiSendMobile({ mobileNumber: "123459876543210" }), null);
    assert.equal(buildWatiSendRecipient({ name: "Farmer", mobileNumber: "123459876543210" }), null);
  });

  it("uses phoneNumber fallback when mobileNumber is absent", () => {
    assert.equal(resolveWatiSendMobile({ phoneNumber: "919876543210" }), "9876543210");
  });
});
