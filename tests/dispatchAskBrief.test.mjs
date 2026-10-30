import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDispatchBrief,
  expandDispatchRange,
  inclusiveDays,
  parseDispatchInsights,
  rulesDispatchInsights,
} from "../utility/dispatchAskBrief.js";

const board = (dispatch, lagwad, extra = {}) => ({
  totals: { dispatch, lagwad, overdueDispatch: extra.overdue || 0, readyLagwad: extra.ready || 0, orderCount: extra.orders || 0, lineCount: 0 },
  windows: extra.windows || [{ from: "2026-10-30", to: "2026-11-08", dispatch, lagwad, overdueDispatch: extra.overdue || 0, readyLagwad: 0, orderCount: 1, lineCount: 1 }],
});

test("expand adds the same number of days before and after", () => {
  const range = expandDispatchRange("2026-10-30", "2026-11-28");
  assert.equal(inclusiveDays(range.focusFrom, range.focusTo), 30);
  assert.equal(range.padDays, 30);
  assert.deepEqual([range.beforeFrom, range.beforeTo], ["2026-09-30", "2026-10-29"]);
  assert.equal(inclusiveDays(range.beforeFrom, range.beforeTo), 30);
  assert.deepEqual([range.afterFrom, range.afterTo], ["2026-11-29", "2026-12-28"]);
  assert.equal(inclusiveDays(range.afterFrom, range.afterTo), 30);
});

test("one selected day still pads one day each side", () => {
  const range = expandDispatchRange("2026-10-30", "2026-10-30");
  assert.equal(range.padDays, 1);
  assert.deepEqual([range.beforeFrom, range.beforeTo], ["2026-10-29", "2026-10-29"]);
  assert.deepEqual([range.afterFrom, range.afterTo], ["2026-10-31", "2026-10-31"]);
  assert.equal(expandDispatchRange("2026-11-02", "2026-11-01"), null);
  assert.equal(expandDispatchRange("nope", "2026-11-01"), null);
});

test("brief keeps selected, before, and after in separate sections", () => {
  const range = expandDispatchRange("2026-10-30", "2026-11-08");
  const text = buildDispatchBrief({
    crop: "Banana",
    subtype: "G9",
    today: "2026-10-30",
    windowDays: 10,
    range,
    before: board(1000, 2000),
    focus: board(5000, 4000),
    after: board(800, 3000),
    question: "Where are bookings short?",
  });
  const selected = text.slice(text.indexOf("=== SELECTED"), text.indexOf("=== AFTER"));
  assert.match(text, /BEFORE \(same 10 days/);
  assert.match(selected, /bookings 5,000/);
  assert.doesNotMatch(selected, /bookings 1,000/);
  assert.match(text, /Question: Where are bookings short\?/);
});

test("rules talk about the selected bookings and use the sides only as comparison", () => {
  const advice = rulesDispatchInsights({
    padDays: 10,
    focus: board(5000, 4000, {
      overdue: 700,
      windows: [
        { from: "2026-10-30", to: "2026-11-08", dispatch: 5000, lagwad: 4000, overdueDispatch: 700, readyLagwad: 0, orderCount: 4, lineCount: 2 },
      ],
    }),
    before: board(2000, 2000),
    after: board(9000, 3000),
  });
  assert.match(advice.headline, /short/i);
  assert.equal(advice.insights[0].tone, "risk");
  assert.match(advice.insights.map((row) => row.detail).join(" "), /previous 10 days/);
  assert.match(advice.insights.map((row) => row.title).join(" "), /Next period/);
  assert.match(advice.insights.map((row) => row.detail).join(" "), /700/);
});

test("parser keeps a JSON object and drops empty rows", () => {
  const advice = parseDispatchInsights(`Sure\n{"headline":"Short on G9","insights":[{"title":"Bookings","detail":"Short by 1,000.","tone":"risk"},{"title":""}]}`);
  assert.equal(advice.headline, "Short on G9");
  assert.equal(advice.insights.length, 1);
  assert.equal(advice.insights[0].tone, "risk");
  assert.equal(parseDispatchInsights("no json"), null);
});
