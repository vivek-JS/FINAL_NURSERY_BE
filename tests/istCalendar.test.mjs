import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCalendarQueryBound,
  normalizeDeliveryDateForStorage,
  parseQueryIstDateRange,
  formatIstYmd,
  istYearBounds,
  normalizeBodyIstCalendarDates,
} from "../utility/istCalendar.js";
import istDateMiddleware from "../middlewares/istDate.middleware.js";

const ORDER_2241_DELIVERY = new Date("2026-06-10T18:30:00.000Z");

test("parseCalendarQueryBound — YYYY-MM-DD uses IST not UTC midnight", () => {
  const start = parseCalendarQueryBound("2026-06-11", false);
  assert.equal(start.toISOString(), "2026-06-10T18:30:00.000Z");
  const end = parseCalendarQueryBound("2026-06-11", true);
  assert.equal(end.toISOString(), "2026-06-11T18:29:59.999Z");
});

test("parseCalendarQueryBound — DD-MM-YYYY order list format", () => {
  const start = parseCalendarQueryBound("11-06-2026", false);
  assert.equal(start.toISOString(), "2026-06-10T18:30:00.000Z");
});

test("normalizeDeliveryDateForStorage — order #2241 regression", () => {
  const stored = normalizeDeliveryDateForStorage(ORDER_2241_DELIVERY);
  assert.equal(stored.toISOString(), "2026-06-10T18:30:00.000Z");
  assert.equal(formatIstYmd(stored), "2026-06-11");
});

test("parseQueryIstDateRange — admin YYYY-MM-DD pair", () => {
  const range = parseQueryIstDateRange({
    startDate: "2026-06-01",
    endDate: "2026-06-07",
  });
  assert.equal(range.format, "ymd");
  assert.equal(range.startYmd, "2026-06-01");
  assert.equal(range.endYmd, "2026-06-07");
  assert.equal(range.dayCount, 7);
});

test("parseQueryIstDateRange — order list DD-MM-YYYY pair", () => {
  const range = parseQueryIstDateRange({
    startDate: "01-06-2026",
    endDate: "07-06-2026",
  });
  assert.equal(range.format, "dd-mm-yyyy");
  assert.equal(range.startYmd, "2026-06-01");
  assert.equal(range.endYmd, "2026-06-07");
});

test("istYearBounds — full year in IST", () => {
  const b = istYearBounds(2026);
  assert.equal(b.start.toISOString(), "2025-12-31T18:30:00.000Z");
  assert.equal(b.end.toISOString(), "2026-12-31T18:29:59.999Z");
});

test("normalizeBodyIstCalendarDates — mutates deliveryDate", () => {
  const body = { deliveryDate: "2026-06-11", quantity: 100 };
  const changed = normalizeBodyIstCalendarDates(body);
  assert.deepEqual(changed, ["deliveryDate"]);
  assert.equal(body.deliveryDate.toISOString(), "2026-06-10T18:30:00.000Z");
});

test("istDateMiddleware — attaches req.ist and normalizes body", () => {
  const req = {
    method: "PATCH",
    query: { startDate: "2026-06-01", endDate: "2026-06-07" },
    body: { deliveryDate: new Date("2026-06-11T00:00:00.000Z") },
  };
  let called = false;
  istDateMiddleware(req, {}, () => {
    called = true;
  });
  assert.equal(called, true);
  assert.ok(req.ist);
  assert.equal(req.istQuery.range.startYmd, "2026-06-01");
  assert.equal(req.istBodyNormalized.includes("deliveryDate"), true);
  assert.equal(formatIstYmd(req.body.deliveryDate), "2026-06-11");
});
