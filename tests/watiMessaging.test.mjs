import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWatiMobile10,
  resolveWatiSendMobile,
} from "../utility/watiMessaging.js";

test("normalizeWatiMobile10 accepts only 10 digits or unambiguous 91-prefixed mobile", () => {
  assert.equal(normalizeWatiMobile10("7588686452"), "7588686452");
  assert.equal(normalizeWatiMobile10("+91 75886 86452"), "7588686452");
});

test("normalizeWatiMobile10 rejects ambiguous overlong numbers", () => {
  assert.equal(normalizeWatiMobile10("001917588686452"), "");
  assert.equal(normalizeWatiMobile10("12345678901"), "");
});

test("resolveWatiSendMobile fails closed for ambiguous recipient numbers", () => {
  assert.equal(resolveWatiSendMobile({ mobileNumber: "91917588686452" }), null);
  assert.equal(resolveWatiSendMobile({ phoneNumber: "917588686452" }), "7588686452");
});
