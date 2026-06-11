import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDeliveryFinalSecondDate,
  formatWatiDateDdMmYyyy,
  formatWatiDateEnIN,
  momentInIst,
} from "../utility/watiIstDateFormat.js";

test("momentInIst — IST midnight storage shows next IST calendar day", () => {
  const m = momentInIst("2026-06-10T18:30:00.000Z");
  assert.equal(m.format("DD-MM-YYYY"), "11-06-2026");
});

test("formatWatiDateEnIN uses IST calendar day for ISO datetimes", () => {
  assert.equal(formatWatiDateEnIN("2026-05-27T18:30:00.000Z"), "28/05/2026");
  assert.equal(formatWatiDateEnIN("2026-06-10T18:30:00.000Z"), "11/06/2026");
});

test("formatWatiDateDdMmYyyy matches template delivery field", () => {
  assert.equal(formatWatiDateDdMmYyyy("2026-05-27T18:30:00.000Z"), "28-May-2026");
  assert.equal(formatWatiDateDdMmYyyy("2026-06-10T18:30:00.000Z"), "11-June-2026");
});

test("formatWatiDateDdMmYyyy — Date object uses IST calendar day", () => {
  assert.equal(
    formatWatiDateDdMmYyyy(new Date("2026-05-27T18:30:00.000Z")),
    "28-May-2026"
  );
});

test("formatDeliveryFinalSecondDate noon UTC storage stays same IST day", () => {
  assert.equal(
    formatDeliveryFinalSecondDate("2026-05-28T12:00:00.000Z"),
    "28-May-2026"
  );
});
