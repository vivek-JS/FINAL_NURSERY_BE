import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeWatiMobile10,
  resolveWatiSendMobile,
  sendOrderAcceptedWhatsApp,
} from "../utility/watiMessaging.js";
import {
  isAcceptedWhatsAppPlantName,
  isPapayaPlantName,
} from "../utility/watiPlantText.js";

test("accepted WhatsApp plant classifier allows Banana and Papaya only", () => {
  assert.equal(isAcceptedWhatsAppPlantName("Banana", "G9"), true);
  assert.equal(isAcceptedWhatsAppPlantName("Papaya", "15 no"), true);
  assert.equal(isPapayaPlantName("Taiwan Papaya", ""), true);
  assert.equal(isAcceptedWhatsAppPlantName("Tomato", "Hybrid"), false);
});

test("accepted WhatsApp skips unsupported plants before WATI send", async () => {
  const result = await sendOrderAcceptedWhatsApp(
    {
      name: "Test Farmer",
      mobileNumber: "9876543210",
      village: "Test Village",
      taluka: "Test Taluka",
    },
    {
      orderId: "ORD-1",
      plantName: "Tomato",
      plantSubtype: "Hybrid",
      numberOfPlants: 100,
      rate: 10,
      totalAmount: 1000,
      advanceAmount: 100,
      remainingAmount: 900,
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "unsupported_plant");
  assert.match(result.error.message, /Banana and Papaya/);
});

test("WATI mobile normalization rejects ambiguous overlong numbers", () => {
  assert.equal(normalizeWatiMobile10("9876543210"), "9876543210");
  assert.equal(normalizeWatiMobile10("+91 98765 43210"), "9876543210");
  assert.equal(normalizeWatiMobile10("09876543210"), "9876543210");
  assert.equal(resolveWatiSendMobile({ mobileNumber: "1239876543210" }), null);
  assert.equal(resolveWatiSendMobile({ phoneNumber: "00919876543210" }), null);
});
