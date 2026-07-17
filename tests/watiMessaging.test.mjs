import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWatiMobile10,
  resolveWatiSendMobile,
} from "../utility/watiMessaging.js";

describe("watiMessaging phone normalization", () => {
  it("accepts 10-digit mobiles and 91-prefixed Indian mobiles", () => {
    assert.equal(normalizeWatiMobile10("9876543210"), "9876543210");
    assert.equal(normalizeWatiMobile10("+91 98765 43210"), "9876543210");
  });

  it("rejects ambiguous overlong numbers instead of slicing the last 10 digits", () => {
    assert.equal(normalizeWatiMobile10("0019876543210"), null);
    assert.equal(
      resolveWatiSendMobile({ mobileNumber: "123459876543210" }),
      null
    );
  });
});
