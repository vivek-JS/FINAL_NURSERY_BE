/**
 * Farm-ready WATI reschedule flow — pure helpers (no DB / WATI).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNextDeliveryDateOptions,
  parseDateChoiceFromReply,
  parseConfirmChoiceFromReply,
  isFarmReadyButtonMessage,
  FARM_READY_BTN_CONFIRM,
  FARM_READY_BTN_RESCHEDULE,
  formatDeliveryDateLabel,
} from "../services/whatsappFarmReadyReschedule.service.js";
import {
  formatSlotOfferLabel,
  parseSlotChoiceFromReply,
} from "../services/whatsappFarmReadySlot.service.js";
import { extractInboundMessage } from "../utility/watiInboundPayload.js";
import {
  extractReplyContextId,
  extractReplyContextText,
  extractOrderRefsFromText,
} from "../utility/whatsappFarmReadyOrderResolve.js";

test("formatSlotOfferLabel — same month window", () => {
  assert.equal(
    formatSlotOfferLabel({ startDay: "05-06-2026", endDay: "10-06-2026", month: "June" }),
    "5 to 10 June"
  );
});

test("parseSlotChoiceFromReply — numeric and label", () => {
  const slots = [
    { label: "5 to 10 June", slotId: "a" },
    { label: "11 to 15 June", slotId: "b" },
  ];
  assert.equal(parseSlotChoiceFromReply("2", slots), 1);
  assert.equal(parseSlotChoiceFromReply("11 to 15 June", slots), 1);
  assert.equal(parseSlotChoiceFromReply("9", slots), null);
});

test("buildNextDeliveryDateOptions — 5 days after delivery date", () => {
  const base = new Date(2026, 4, 27);
  const opts = buildNextDeliveryDateOptions(base, 5);
  assert.equal(opts.length, 5);
  assert.equal(formatDeliveryDateLabel(opts[0]), "28 May 2026");
});

test("parseConfirmChoiceFromReply — 1 confirm, 2 cancel, slot label", () => {
  assert.equal(parseConfirmChoiceFromReply("1", "5 to 10 June"), "confirm");
  assert.equal(parseConfirmChoiceFromReply("2", "5 to 10 June"), "cancel");
  assert.equal(parseConfirmChoiceFromReply("5 to 10 June", "5 to 10 June"), "confirm");
});

test("isFarmReadyButtonMessage", () => {
  assert.equal(isFarmReadyButtonMessage(FARM_READY_BTN_CONFIRM), true);
  assert.equal(isFarmReadyButtonMessage(FARM_READY_BTN_RESCHEDULE), true);
});

test("extractReplyContextId from WATI button reply", () => {
  assert.equal(
    extractReplyContextId({
      replyContextId: "d38f0c3a-e833-4725-a894-53a2b1dc1af6",
    }),
    "d38f0c3a-e833-4725-a894-53a2b1dc1af6"
  );
});

test("extractOrderRefsFromText — ऑर्डर आयडी from template", () => {
  const refs = extractOrderRefsFromText("तुमचा ऑर्डर आयडी: 4521");
  assert.ok(refs.some((r) => r.value === "4521"));
});

test("extractReplyContextText — parent template message", () => {
  assert.equal(
    extractReplyContextText({
      replyContextMessage: { text: "तुमचा ऑर्डर आयडी: 7832" },
    }),
    "तुमचा ऑर्डर आयडी: 7832"
  );
});

test("extractInboundMessage prefers buttonText", () => {
  const { text } = extractInboundMessage({
    waId: "919876543210",
    buttonText: FARM_READY_BTN_RESCHEDULE,
  });
  assert.equal(text, FARM_READY_BTN_RESCHEDULE);
});

function sameDay(a, b) {
  if (!a || !b) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
