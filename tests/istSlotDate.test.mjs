import test from "node:test";
import assert from "node:assert/strict";
import {
  deliveryDateToIstMoment,
  isDeliveryDateInSlotWindow,
  slotWindowToDeliveryUtcRange,
} from "../utility/istSlotDate.js";

const ORDER_2241_DELIVERY = new Date("2026-06-10T18:30:00.000Z");
const SLOT_JUN_4_10 = { startDay: "04-06-2026", endDay: "10-06-2026" };
const SLOT_JUN_11_17 = { startDay: "11-06-2026", endDay: "17-06-2026" };

test("deliveryDateToIstMoment — IST midnight storage maps to correct calendar day", () => {
  const m = deliveryDateToIstMoment(ORDER_2241_DELIVERY);
  assert.equal(m.format("DD-MM-YYYY"), "11-06-2026");
});

test("order 2241 — delivery cohort and Mongo range agree on Jun 11-17 slot", () => {
  assert.equal(isDeliveryDateInSlotWindow(ORDER_2241_DELIVERY, SLOT_JUN_4_10), false);
  assert.equal(isDeliveryDateInSlotWindow(ORDER_2241_DELIVERY, SLOT_JUN_11_17), true);

  const range = slotWindowToDeliveryUtcRange(SLOT_JUN_11_17);
  assert.equal(range.start.toISOString(), "2026-06-10T18:30:00.000Z");
  assert.equal(range.end.toISOString(), "2026-06-17T18:29:59.999Z");
  assert.ok(ORDER_2241_DELIVERY >= range.start && ORDER_2241_DELIVERY <= range.end);

  const expiredRange = slotWindowToDeliveryUtcRange(SLOT_JUN_4_10);
  assert.ok(
    ORDER_2241_DELIVERY < expiredRange.start || ORDER_2241_DELIVERY > expiredRange.end
  );
});

test("slotWindowToDeliveryUtcRange — Jun 4-10 IST window", () => {
  const range = slotWindowToDeliveryUtcRange(SLOT_JUN_4_10);
  assert.equal(range.start.toISOString(), "2026-06-03T18:30:00.000Z");
  assert.equal(range.end.toISOString(), "2026-06-10T18:29:59.999Z");
});
