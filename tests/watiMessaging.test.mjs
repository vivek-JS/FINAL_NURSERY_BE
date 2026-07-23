import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWatiSendRecipient,
  normalizeWatiMobile10,
  resolveWatiSendMobile,
} from "../utility/watiMessaging.js";

test("normalizeWatiMobile10 accepts only 10 digits or exact 91-prefixed numbers", () => {
  assert.equal(normalizeWatiMobile10("9876543210"), "9876543210");
  assert.equal(normalizeWatiMobile10("+91 98765 43210"), "9876543210");
  assert.equal(normalizeWatiMobile10("919876543210"), "9876543210");
});

test("normalizeWatiMobile10 rejects ambiguous overlong numbers", () => {
  assert.equal(normalizeWatiMobile10("00919876543210"), "");
  assert.equal(normalizeWatiMobile10("9876543210123"), "");
  assert.equal(resolveWatiSendMobile({ mobileNumber: "00919876543210" }), null);
});

test("buildWatiSendRecipient does not rewrite invalid overlong phone numbers", () => {
  assert.equal(
    buildWatiSendRecipient({ name: "Farmer", mobileNumber: "1239876543210" }),
    null
  );
  assert.deepEqual(
    buildWatiSendRecipient({ name: "Farmer", phoneNumber: "919876543210" }),
    { name: "Farmer", phoneNumber: "919876543210", mobileNumber: "9876543210" }
  );
});
