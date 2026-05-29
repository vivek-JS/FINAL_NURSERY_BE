/**
 * delivery_final_second template — scheduling + params (no DB / WATI).
 */
import test from "node:test";
import assert from "node:assert/strict";
import moment from "moment";
import {
  formatDeliveryFinalSecondDate,
  buildDeliveryFinalSecondParameters,
} from "../utility/watiMessaging.js";
import {
  isPastDueDeliveryDate,
  isDeliveryDueInDays,
  classifyDeliveryFinalSecondTrigger,
  DELIVERY_FINAL_TRIGGERS,
} from "../services/deliveryFinalSecondWhatsapp.service.js";
import {
  isFarmReadyButtonMessage,
  FARM_READY_BTN_CONFIRM_DOTTED,
} from "../services/whatsappFarmReadyReschedule.service.js";

const IST = "+05:30";
const ref = moment("2026-05-28T10:00:00").utcOffset(IST);

test("formatDeliveryFinalSecondDate", () => {
  assert.equal(
    formatDeliveryFinalSecondDate(new Date(2025, 4, 28)),
    "28-May-2025"
  );
});

test("formatDeliveryFinalSecondDate — IST when UTC instant is previous evening", () => {
  // May 28 00:00 IST often stored as 2026-05-27T18:30:00.000Z
  assert.equal(
    formatDeliveryFinalSecondDate("2026-05-27T18:30:00.000Z"),
    "28-May-2026"
  );
});

test("buildDeliveryFinalSecondParameters — {{2}} plant, {{3}} subtype", () => {
  const params = buildDeliveryFinalSecondParameters(
    { name: "Vivek" },
    {
      publicOrderCode: "1212",
      plantName: "Banana",
      plantSubtype: "G9",
      numberOfPlants: 5000,
      deliveryDate: new Date(2025, 4, 28),
    }
  );
  const map = Object.fromEntries(params.map((p) => [p.name, p.value]));
  assert.equal(map["1"], "Vivek");
  assert.equal(map["2"], "केळी");
  assert.equal(map["3"], "G9");
  assert.equal(map["4"], "28-May-2025");
  assert.equal(map["5"], "1212");
});

test("buildDeliveryFinalSecondParameters — empty subtype (no em dash)", () => {
  const params = buildDeliveryFinalSecondParameters(
    { name: "Vivek" },
    {
      plantName: "Banana",
      plantSubtype: "",
      deliveryDate: new Date(2025, 4, 28),
      orderId: 100,
    }
  );
  const map = Object.fromEntries(params.map((p) => [p.name, p.value]));
  assert.equal(map["2"], "केळी");
  assert.equal(map["3"], "");
});

test("buildDeliveryFinalSecondParameters — prefers orderId over publicOrderCode for {{5}}", () => {
  const params = buildDeliveryFinalSecondParameters(
    { name: "Vivek" },
    {
      publicOrderCode: "4521",
      orderId: 5586,
      plantName: "Banana",
      plantSubtype: "G9",
      numberOfPlants: 5000,
      deliveryDate: new Date(2025, 4, 28),
    }
  );
  const map = Object.fromEntries(params.map((p) => [p.name, p.value]));
  assert.equal(map["4"], "28-May-2025");
  assert.equal(map["5"], "5586");
});

test("past due and due in 7 days classification", () => {
  assert.equal(isPastDueDeliveryDate(new Date(2026, 4, 20), ref), true);
  assert.equal(isPastDueDeliveryDate(new Date(2026, 4, 28), ref), false);
  assert.equal(isDeliveryDueInDays(new Date(2026, 5, 4), 7, ref), true);
  assert.equal(
    classifyDeliveryFinalSecondTrigger(new Date(2026, 4, 15), ref),
    DELIVERY_FINAL_TRIGGERS.PAST_DUE
  );
  assert.equal(
    classifyDeliveryFinalSecondTrigger(new Date(2026, 5, 4), ref),
    DELIVERY_FINAL_TRIGGERS.DUE_IN_7_DAYS
  );
});

test("isFarmReadyButtonMessage accepts WATI button with period", () => {
  assert.equal(isFarmReadyButtonMessage(FARM_READY_BTN_CONFIRM_DOTTED), true);
});

test("farmReadyWhatsAppSkipReason — Banana only", async () => {
  const { farmReadyWhatsAppSkipReason } = await import(
    "../services/deliveryFinalSecondWhatsapp.service.js"
  );
  assert.equal(
    farmReadyWhatsAppSkipReason({ plantName: { name: "Banana" } }, "G9"),
    null
  );
  assert.equal(
    farmReadyWhatsAppSkipReason({ plantName: { name: "Papaya" } }, "15 no"),
    "not_banana"
  );
});
