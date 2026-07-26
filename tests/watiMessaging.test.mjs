import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWatiMobile10,
  resolveWatiSendMobile,
} from "../utility/watiMessaging.js";

describe("watiMessaging mobile normalization", () => {
  it("accepts 10-digit Indian mobile numbers", () => {
    assert.equal(normalizeWatiMobile10("9876543210"), "9876543210");
  });

  it("accepts 91-prefixed 12-digit Indian mobile numbers", () => {
    assert.equal(normalizeWatiMobile10("+91 98765 43210"), "9876543210");
  });

  it("rejects ambiguous overlong numbers instead of slicing the last 10 digits", () => {
    assert.equal(normalizeWatiMobile10("001-919876543210"), "");
    assert.equal(resolveWatiSendMobile({ mobileNumber: "1234567890123" }), null);
  });
});
