import test from "node:test";
import assert from "node:assert/strict";
import moment from "moment";
import {
  boardRowHasNumbers,
  boardSlotCell,
  buildBoardRow,
  dominantSlotDays,
  overdueSlotCell,
  shedStockByVariety,
  slotLengthDays,
  slotTiming,
  parseGroupDays,
} from "../utility/capacityBoardMetrics.js";
import { IST_OFFSET } from "../utility/istSlotDate.js";

const today = moment("2026-10-16", "YYYY-MM-DD").utcOffset(IST_OFFSET, true).startOf("day");

test("slot length and timing on IST days", () => {
  assert.equal(slotLengthDays("16-10-2026", "16-10-2026"), 1);
  assert.equal(slotLengthDays("12-10-2026", "18-10-2026"), 7);
  assert.equal(slotTiming("10-10-2026", "15-10-2026", today), "past");
  assert.equal(slotTiming("12-10-2026", "18-10-2026", today), "current");
  assert.equal(slotTiming("16-10-2026", "16-10-2026", today), "current");
  assert.equal(slotTiming("17-10-2026", "17-10-2026", today), "upcoming");
});

test("dominant slot length picks the most common, ties go shorter", () => {
  assert.equal(
    dominantSlotDays([
      { startDay: "01-10-2026", endDay: "07-10-2026" },
      { startDay: "08-10-2026", endDay: "14-10-2026" },
      { startDay: "15-10-2026", endDay: "15-10-2026" },
    ]),
    7
  );
  assert.equal(
    dominantSlotDays([
      { startDay: "01-10-2026", endDay: "07-10-2026" },
      { startDay: "15-10-2026", endDay: "15-10-2026" },
    ]),
    1
  );
});

test("slot cell: ready = sowed against orders + free excess, net = ready - booked", () => {
  const cell = boardSlotCell({ slotId: "a", booked: 12300, gap: 2000, excess: 800 });
  assert.equal(cell.ready, 11100);
  assert.equal(cell.net, -1200);
  assert.equal(cell.ready - cell.booked, cell.net);
});

test("overdue cell only counts orders still waiting to dispatch", () => {
  const cell = overdueSlotCell({ slotId: "p", pendingDispatch: 5100, gap: 1000, excess: 300 });
  assert.equal(cell.booked, 5100);
  assert.equal(cell.ready, 4400);
  assert.equal(cell.net, -700);
  assert.equal(cell.unsold, 300);
});

test("board row folds overdue into current and keeps next slots in order", () => {
  const slots = [
    { slotId: "s3", startDay: "26-10-2026", endDay: "01-11-2026", booked: 100, gap: 0, excess: 50, pendingDispatch: 100 },
    { slotId: "s0", startDay: "05-10-2026", endDay: "11-10-2026", booked: 900, gap: 400, excess: 0, pendingDispatch: 600 },
    { slotId: "s1", startDay: "12-10-2026", endDay: "18-10-2026", booked: 1000, gap: 200, excess: 100, pendingDispatch: 1000 },
    { slotId: "s2", startDay: "19-10-2026", endDay: "25-10-2026", booked: 500, gap: 0, excess: 1500, pendingDispatch: 500 },
  ];
  const row = buildBoardRow({ slots, today });
  assert.equal(row.slotDays, 7);
  assert.equal(row.current.slotId, "s1");
  assert.deepEqual(row.current.slotIds, ["s1", "s0"]);
  assert.equal(row.current.overdue.booked, 600);
  assert.equal(row.current.overdue.ready, 200);
  assert.equal(row.current.booked, 1600);
  assert.equal(row.current.ready, 1100);
  assert.equal(row.current.net, -500);
  assert.deepEqual(row.upcoming.map((c) => c.slotId), ["s2", "s3"]);
  assert.equal(row.upcoming[0].net, 1500);
  assert.equal(row.totals.ready, 1100 + 2000 + 150);
});

const daySlot = (day, excess, booked = 0) => ({
  slotId: `d${day}`,
  startDay: `${day}-10-2026`,
  endDay: `${day}-10-2026`,
  booked,
  gap: 0,
  excess,
  pendingDispatch: booked,
});

test("day-wise cells skip empty days and stay inside the table window", () => {
  const slots = [daySlot("16", 100), daySlot("17", 0), daySlot("18", 0), daySlot("20", 300, 200), daySlot("29", 50)];
  const row = buildBoardRow({ slots, today, tableDays: 10 });
  assert.equal(row.now.key, "now");
  assert.equal(row.now.ready, 100);
  assert.deepEqual(
    row.cells.map((c) => [c.key, c.ready, c.booked, c.slotIds.join()]),
    [["2026-10-20", 500, 200, "d20"]]
  );
  assert.equal(row.upcoming.length, 4);
  assert.equal(row.totals.ready, 600);
});

test("3-day groups count from today; the first group folds into now", () => {
  const slots = [
    { slotId: "old", startDay: "14-10-2026", endDay: "14-10-2026", booked: 300, gap: 300, excess: 0, pendingDispatch: 300 },
    daySlot("16", 100),
    daySlot("17", 200),
    daySlot("18", 0),
    daySlot("20", 300, 100),
    daySlot("21", 50),
    daySlot("25", 70),
  ];
  const row = buildBoardRow({ slots, today, groupDays: 3 });
  assert.equal(row.now.startDay, "16-10-2026");
  assert.equal(row.now.endDay, "18-10-2026");
  assert.equal(row.now.ready, 100 + 200);
  assert.equal(row.now.booked, 300);
  assert.equal(row.now.overdue.booked, 300);
  assert.deepEqual(row.now.slotIds, ["d16", "old", "d17"]);
  assert.equal(row.current.ready, 100);
  assert.deepEqual(
    row.cells.map((c) => [c.key, c.startDay, c.endDay, c.ready, c.slotIds.join()]),
    [
      ["2026-10-19", "19-10-2026", "21-10-2026", 450, "d20,d21"],
      ["2026-10-25", "25-10-2026", "27-10-2026", 70, "d25"],
    ]
  );
  assert.equal(parseGroupDays("3"), 3);
  assert.equal(parseGroupDays("junk"), 1);
  assert.equal(parseGroupDays(99), 7);
});

test("board row without a slot today still shows overdue as the current cell", () => {
  const row = buildBoardRow({
    slots: [
      { slotId: "old", startDay: "14-10-2026", endDay: "14-10-2026", booked: 300, gap: 300, excess: 0, pendingDispatch: 300 },
      { slotId: "next", startDay: "17-10-2026", endDay: "17-10-2026", booked: 0, gap: 0, excess: 0, pendingDispatch: 0 },
    ],
    today,
  });
  assert.equal(row.current.slotId, null);
  assert.equal(row.current.net, -300);
  assert.deepEqual(row.current.slotIds, ["old"]);
  assert.equal(boardRowHasNumbers(row), true);
});

test("empty row is hidden unless the shed holds stock", () => {
  const empty = buildBoardRow({ slots: [], today });
  assert.equal(boardRowHasNumbers(empty), false);
  const stocked = buildBoardRow({ slots: [], today, stock: { inShed: 50, readyNow: 0, batches: [] } });
  assert.equal(boardRowHasNumbers(stocked), true);
});

test("shed stock rolls up per variety and skips empty batches", () => {
  const map = shedStockByVariety({
    sheds: [
      {
        shed: "A-1",
        batches: [
          {
            plantId: "p",
            plantName: "Banana",
            subtypeId: "s",
            subtypeName: "G9",
            batchNumber: "B1",
            remaining: 5200,
            readyRemaining: 5000,
            lines: [
              { remaining: 5000, ready: true, lagwadDate: "2026-08-22", readyDate: "2026-10-16" },
              { remaining: 200, ready: false, lagwadDate: "2026-09-10", readyDate: "2026-10-30" },
              { remaining: 0, ready: true, lagwadDate: "2026-08-01", readyDate: "2026-09-01" },
            ],
          },
          { plantId: "p", subtypeId: "s", batchNumber: "B0", remaining: 0, readyRemaining: 0, lines: [] },
        ],
      },
      {
        shed: "B-2",
        batches: [{ plantId: "p", subtypeId: "s", batchNumber: "B2", remaining: 5900, readyRemaining: 0, lines: [] }],
      },
    ],
  });
  const entry = map.get("p-s");
  assert.equal(entry.inShed, 11100);
  assert.equal(entry.readyNow, 5000);
  assert.deepEqual(entry.batches.map((b) => b.batchNumber), ["B2", "B1"]);
  assert.equal(entry.plantName, "Banana");
  assert.equal(entry.subtypeName, "G9");
  assert.equal(entry.batches[1].lagwadDate.toISOString().slice(0, 10), "2026-08-22");
  assert.equal(entry.batches[1].notReady, 200);
  assert.equal(entry.batches[1].nextReadyDate.toISOString().slice(0, 10), "2026-10-30");
});
