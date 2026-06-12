import test from "node:test";
import assert from "node:assert/strict";
import { devanagariToAsciiDigits } from "../utility/devanagariNumerals.js";

test("devanagariToAsciiDigits converts Marathi digits ०–९", () => {
  assert.equal(devanagariToAsciiDigits("०१२३४५६७८९"), "0123456789");
});

test("devanagariToAsciiDigits converts mixed Marathi amount", () => {
  assert.equal(devanagariToAsciiDigits("₹ १,२३४.५०"), "₹ 1,234.50");
});

test("devanagariToAsciiDigits leaves Western digits unchanged", () => {
  assert.equal(devanagariToAsciiDigits("UTR 123456789012"), "UTR 123456789012");
});

test("devanagariToAsciiDigits handles nullish", () => {
  assert.equal(devanagariToAsciiDigits(null), null);
  assert.equal(devanagariToAsciiDigits(undefined), undefined);
});
