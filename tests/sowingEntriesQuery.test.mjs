import test from "node:test";
import assert from "node:assert/strict";
import {
  istHalfOpenRange,
  sowDayStringRange,
  calendarDaysLeft,
  entryMatchesFilters,
  sortEntryItems,
  pageEntryItems,
  istTodayYmd,
} from "../utility/sowingEntriesQuery.js";

const today = "2026-10-28";

function row(id, { sow = "2026-01-01", excess = 0, ready = "12-11-2026" } = {}) {
  return {
    _id: id,
    sowingDate: sow,
    excessPlants: excess,
    affectedSlot: ready ? { plantReadyDate: ready } : {},
  };
}

test("equal from and to is one India calendar day, not empty", () => {
  const range = istHalfOpenRange("2026-10-25", "2026-10-25");
  assert.equal(range.$gte.toISOString(), "2026-10-24T18:30:00.000Z");
  assert.equal(range.$lt.toISOString(), "2026-10-25T18:30:00.000Z");
  const justInside = new Date("2026-10-25T18:29:59.000Z");
  const nextMidnight = new Date("2026-10-25T18:30:00.000Z");
  assert.equal(justInside >= range.$gte && justInside < range.$lt, true);
  assert.equal(nextMidnight < range.$lt, false);
  const strings = sowDayStringRange("2026-10-25", "2026-10-25");
  assert.deepEqual(strings, { $gte: "2026-10-25", $lte: "2026-10-25" });
});

test("days left uses calendar days and strict bounds", () => {
  assert.equal(calendarDaysLeft("2026-11-12", today), 15);
  const onReady = row("a", { ready: "12-11-2026", excess: 10 });
  assert.equal(entryMatchesFilters(onReady, { daysLeftGt: "15" }, today), false);
  assert.equal(entryMatchesFilters(onReady, { daysLeftGt: "14" }, today), true);
  assert.equal(entryMatchesFilters(onReady, { daysLeftLt: "16" }, today), true);
  assert.equal(entryMatchesFilters(onReady, { daysLeftLt: "15" }, today), false);
  assert.equal(entryMatchesFilters(onReady, { readyDate: "2026-11-12" }, today), true);
  assert.equal(entryMatchesFilters(onReady, { readyDate: "2026-11-13" }, today), false);
});

test("rows without a ready date miss ready and days filters", () => {
  const bare = row("b", { ready: null, excess: 8 });
  assert.equal(entryMatchesFilters(bare, { readyDate: "2026-11-12" }, today), false);
  assert.equal(entryMatchesFilters(bare, { daysLeftGt: "1" }, today), false);
  assert.equal(entryMatchesFilters(bare, { daysLeftLt: "100" }, today), false);
  assert.equal(entryMatchesFilters(bare, { excessOnly: "true" }, today), true);
  assert.equal(entryMatchesFilters(row("c", { excess: 0 }), { excessOnly: "true" }, today), false);
});

test("excess sort and pagination use the full match set", () => {
  const items = [];
  for (let i = 0; i < 120; i += 1) {
    items.push(
      row(String(i).padStart(4, "0"), {
        sow: "2026-10-01",
        excess: i === 5 ? 900 : i,
        ready: "01-11-2026",
      })
    );
  }
  const matched = items.filter((item) => entryMatchesFilters(item, { excessOnly: "true" }, today));
  assert.equal(matched.length, 119);
  const sorted = sortEntryItems(matched, "excess", "desc");
  assert.equal(sorted[0]._id, "0005");
  assert.equal(sorted[1].excessPlants, 119);
  const page = pageEntryItems(sorted, 2, 100);
  assert.equal(page.total, 119);
  assert.equal(page.items.length, 19);
  assert.equal(page.items[0]._id, sorted[100]._id);
  const tied = sortEntryItems(
    [
      row("b", { excess: 4, sow: "2026-10-02" }),
      row("a", { excess: 4, sow: "2026-10-02" }),
    ],
    "excess",
    "desc"
  );
  assert.deepEqual(tied.map((item) => item._id), ["a", "b"]);
});

test("ist today is the Kolkata calendar day", () => {
  assert.equal(istTodayYmd(new Date("2026-10-24T18:30:00.000Z")), "2026-10-25");
  assert.equal(istTodayYmd(new Date("2026-10-24T18:29:00.000Z")), "2026-10-24");
});
