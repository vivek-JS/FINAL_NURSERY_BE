import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWatiSendRecipient,
  normalizeWatiMobile10,
  resolveWatiSendMobile,
} from "../utility/watiMessaging.js";

test("normalizeWatiMobile10 accepts only unambiguous Indian mobile formats", () => {
  assert.equal(normalizeWatiMobile10("9876543210"), "9876543210");
  assert.equal(normalizeWatiMobile10("+91 98765 43210"), "9876543210");
  assert.equal(normalizeWatiMobile10("09876543210"), "9876543210");

  assert.equal(normalizeWatiMobile10("91987654321"), "");
  assert.equal(normalizeWatiMobile10("98765432109876543210"), "");
  assert.equal(normalizeWatiMobile10(""), "");
});

test("buildWatiSendRecipient normalizes accepted recipients and rejects ambiguous ones", () => {
  assert.equal(
    resolveWatiSendMobile({ phoneNumber: "+91 98765 43210" }),
    "9876543210"
  );
  assert.deepEqual(
    buildWatiSendRecipient(
      { name: "Dealer", phoneNumber: "+91 98765 43210" },
      { taluka: "Pune" }
    ),
    {
      name: "Dealer",
      phoneNumber: "+91 98765 43210",
      taluka: "Pune",
      mobileNumber: "9876543210",
    }
  );

  assert.equal(resolveWatiSendMobile({ phoneNumber: "91987654321" }), null);
  assert.equal(
    buildWatiSendRecipient({ name: "Dealer", phoneNumber: "98765432109876543210" }),
    null
  );
});
