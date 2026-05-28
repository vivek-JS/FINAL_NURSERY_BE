/**
 * Cancel-revive WhatsApp — button detection + template params.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOrderCancelledParameters,
} from "../utility/watiMessaging.js";
import {
  isCancelReviveButtonMessage,
  isCancelReviveConfirmMessage,
  CANCEL_DISMISS_BTN,
  CANCEL_REVIVE_BTN,
  CANCEL_REVIVE_BTN_ALT,
} from "../services/whatsappOrderCancelRevive.service.js";
import { extractOrderRefsFromText } from "../utility/whatsappFarmReadyOrderResolve.js";

test("buildOrderCancelledParameters — order id, booking date, slot", () => {
  const params = buildOrderCancelledParameters(
    { name: "Vivek" },
    {
      publicOrderCode: "7712",
      plantName: "Dummy",
      numberOfPlants: 2000,
      orderBookingDate: new Date(2026, 3, 7),
      deliverySlotLabel: "7 to 13 April",
    }
  );
  const map = Object.fromEntries(params.map((p) => [p.name, p.value]));
  assert.equal(map["1"], "Vivek");
  assert.equal(map["2"], "Dummy");
  assert.equal(map["3"], "2000");
  assert.equal(map["4"], "7712");
  assert.equal(map["5"], "07/04/2026");
  assert.equal(map["6"], "2000");
  assert.equal(map["7"], "7 to 13 April");
});

test("isCancelReviveButtonMessage", () => {
  assert.equal(isCancelReviveButtonMessage(CANCEL_DISMISS_BTN), true);
  assert.equal(isCancelReviveButtonMessage(CANCEL_REVIVE_BTN), true);
  assert.equal(isCancelReviveButtonMessage(CANCEL_REVIVE_BTN_ALT), true);
  assert.equal(isCancelReviveButtonMessage("शेत तयार आहे"), false);
});

test("isCancelReviveConfirmMessage", () => {
  assert.equal(isCancelReviveConfirmMessage(CANCEL_REVIVE_BTN), true);
  assert.equal(isCancelReviveConfirmMessage(CANCEL_DISMISS_BTN), false);
});

test("extractOrderRefsFromText — Order ID line", () => {
  const refs = extractOrderRefsFromText("Order ID: 7712");
  assert.ok(refs.some((r) => r.value === "7712"));
});
