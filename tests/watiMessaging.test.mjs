import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWatiSendRecipient,
  normalizeWatiMobile10,
  resolveWatiSendMobile,
} from "../utility/watiMessaging.js";

test("normalizeWatiMobile10 accepts only unambiguous Indian mobile numbers", () => {
  assert.equal(normalizeWatiMobile10("9876543210"), "9876543210");
  assert.equal(normalizeWatiMobile10("+91 98765 43210"), "9876543210");
  assert.equal(normalizeWatiMobile10("91-98765-43210"), "9876543210");

  assert.equal(normalizeWatiMobile10("001919876543210"), "");
  assert.equal(normalizeWatiMobile10("12345678901"), "");
  assert.equal(normalizeWatiMobile10("9198765432109"), "");
  assert.equal(normalizeWatiMobile10("987654321"), "");
});

test("WATI recipient helpers reject ambiguous overlong numbers", () => {
  assert.equal(resolveWatiSendMobile({ mobileNumber: "001919876543210" }), null);
  assert.equal(
    buildWatiSendRecipient({ name: "Farmer", mobileNumber: "12345678901" }),
    null
  );
});
