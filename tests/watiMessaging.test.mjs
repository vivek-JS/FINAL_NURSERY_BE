import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWatiMobile10,
  resolveWatiSendMobile,
} from "../utility/watiMessaging.js";

describe("watiMessaging phone normalization", () => {
  it("accepts exact local and unambiguous Indian-prefixed mobile numbers", () => {
    assert.equal(normalizeWatiMobile10("9876543210"), "9876543210");
    assert.equal(normalizeWatiMobile10("+91 98765 43210"), "9876543210");
    assert.equal(normalizeWatiMobile10("09876543210"), "9876543210");
  });

  it("rejects ambiguous overlong numbers instead of slicing the last ten digits", () => {
    assert.equal(normalizeWatiMobile10("91987654321099"), "");
    assert.equal(resolveWatiSendMobile({ mobileNumber: "91987654321099" }), null);
  });
});
