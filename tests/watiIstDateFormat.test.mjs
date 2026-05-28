import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDeliveryFinalSecondDate,
  formatWatiDateDdMmYyyy,
  formatWatiDateEnIN,
} from "../utility/watiIstDateFormat.js";

test("formatWatiDateEnIN uses Asia/Kolkata not UTC day", () => {
  assert.equal(formatWatiDateEnIN("2026-05-27T18:30:00.000Z"), "28/05/2026");
});

test("formatWatiDateDdMmYyyy matches template delivery field", () => {
  assert.equal(formatWatiDateDdMmYyyy("2026-05-27T18:30:00.000Z"), "28/05/2026");
});

test("formatDeliveryFinalSecondDate noon UTC storage stays same IST day", () => {
  assert.equal(
    formatDeliveryFinalSecondDate("2026-05-28T12:00:00.000Z"),
    "28-May-2026"
  );
});
