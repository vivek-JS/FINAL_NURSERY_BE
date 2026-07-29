import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWatiMobile10,
  resolveWatiSendMobile,
} from "../utility/watiMessaging.js";

describe("watiMessaging mobile normalization", () => {
  it("accepts exact Indian mobile formats", () => {
    assert.equal(normalizeWatiMobile10("9876543210"), "9876543210");
    assert.equal(normalizeWatiMobile10("+91 98765 43210"), "9876543210");
  });

  it("rejects ambiguous overlong values instead of slicing to another number", () => {
    assert.equal(normalizeWatiMobile10("0019876543210"), "");
    assert.equal(resolveWatiSendMobile({ mobileNumber: "987654321099" }), null);
  });
});
