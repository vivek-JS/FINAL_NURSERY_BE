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
import { extractInboundMessage } from "../utility/watiInboundPayload.js";

test("buildNextDeliveryDateOptions — 5 days after delivery date", () => {
  const base = new Date(2026, 4, 27); // 27 May 2026 (local)
  const opts = buildNextDeliveryDateOptions(base, 5);
  assert.equal(opts.length, 5);
  assert.equal(formatDeliveryDateLabel(opts[0]), "28 May 2026");
  assert.equal(formatDeliveryDateLabel(opts[4]), "01 June 2026");
});

test("parseDateChoiceFromReply — numeric choice", () => {
  const dates = buildNextDeliveryDateOptions(new Date("2026-05-27"), 5);
  assert.ok(sameDay(parseDateChoiceFromReply("2", dates), dates[1]));
  assert.equal(parseDateChoiceFromReply("9", dates), null);
});

test("parseConfirmChoiceFromReply — 1 confirm, 2 cancel", () => {
  const picked = new Date(2026, 4, 29);
  assert.equal(parseConfirmChoiceFromReply("1", picked), "confirm");
  assert.equal(parseConfirmChoiceFromReply("1️⃣", picked), "confirm");
  assert.equal(parseConfirmChoiceFromReply("2", picked), "cancel");
  assert.equal(parseConfirmChoiceFromReply("2️⃣", picked), "cancel");
  assert.equal(parseConfirmChoiceFromReply("हो", picked), null);
  assert.equal(parseConfirmChoiceFromReply("नाही", picked), null);
});

test("parseConfirmChoiceFromReply — date label reply confirms", () => {
  const picked = new Date(2026, 4, 29);
  const label = formatDeliveryDateLabel(picked);
  assert.equal(parseConfirmChoiceFromReply(label, picked), "confirm");
  assert.equal(parseConfirmChoiceFromReply(` ${label} `, picked), "confirm");
});

test("isFarmReadyButtonMessage", () => {
  assert.equal(isFarmReadyButtonMessage(FARM_READY_BTN_CONFIRM), true);
  assert.equal(isFarmReadyButtonMessage(FARM_READY_BTN_RESCHEDULE), true);
  assert.equal(isFarmReadyButtonMessage("hello"), false);
});

test("extractInboundMessage prefers buttonText", () => {
  const { text, buttonText } = extractInboundMessage({
    waId: "919876543210",
    text: "ignored",
    buttonText: FARM_READY_BTN_RESCHEDULE,
  });
  assert.equal(text, FARM_READY_BTN_RESCHEDULE);
  assert.equal(buttonText, FARM_READY_BTN_RESCHEDULE);
});

test("extractInboundMessage nested WATI list reply", () => {
  const dates = buildNextDeliveryDateOptions(new Date("2026-05-27"), 5);
  const label = formatDeliveryDateLabel(dates[2]);
  const { text } = extractInboundMessage({
    waId: "919876543210",
    data: { waId: "919876543210", listReply: { title: label } },
  });
  assert.equal(text, label);
});

function sameDay(a, b) {
  if (!a || !b) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
