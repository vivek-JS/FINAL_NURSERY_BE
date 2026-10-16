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
  upcomingSlotCount,
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
  assert.equal(upcomingSlotCount(1), 7);
  assert.equal(upcomingSlotCount(7), 4);
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

test("upcoming keeps every future slot; totals only cover the table columns", () => {
  const slots = Array.from({ length: 10 }, (_, i) => {
    const day = String(17 + i).padStart(2, "0");
    return { slotId: `d${i}`, startDay: `${day}-10-2026`, endDay: `${day}-10-2026`, booked: 0, gap: 0, excess: 100, pendingDispatch: 0 };
  });
  const row = buildBoardRow({ slots, today });
  assert.equal(row.upcoming.length, 10);
  assert.equal(row.totals.ready, 7 * 100);
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
            subtypeId: "s",
            batchNumber: "B1",
            remaining: 5200,
            readyRemaining: 5000,
            lines: [
              { remaining: 5200, lagwadDate: "2026-08-22", readyDate: "2026-10-16" },
              { remaining: 0, lagwadDate: "2026-08-01", readyDate: "2026-09-01" },
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
  assert.equal(entry.batches[1].lagwadDate.toISOString().slice(0, 10), "2026-08-22");
});
