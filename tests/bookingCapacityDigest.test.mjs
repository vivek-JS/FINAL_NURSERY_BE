/**
 * FIFO booking capacity digest — pure format / canSell tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { canSellSlots } from "../utility/canSellSlots.js";
import {
  buildBookingCapacityVarieties,
  formatBookingCapacityDigestMessages,
  formatRangeLabel,
  toYmd,
  windowsFromBoardRow,
} from "../utility/bookingCapacityDigestFormat.js";

test("toYmd parses DD-MM-YYYY and YYYY-MM-DD", () => {
  assert.equal(toYmd("14-11-2026"), "2026-11-14");
  assert.equal(toYmd("2026-11-14"), "2026-11-14");
});

test("formatRangeLabel compact same month", () => {
  assert.equal(formatRangeLabel("2026-11-14", "2026-11-18"), "14–18 Nov");
});

test("canSellSlots locks earlier surplus for later short", () => {
  const slots = canSellSlots([
    { key: "a", from: "2026-11-14", to: "2026-11-18", lagwad: 25000, dispatch: 15000 },
    { key: "b", from: "2026-11-19", to: "2026-11-23", lagwad: 5000, dispatch: 10000 },
  ]);
  assert.equal(slots[0].canSell, 5000);
  assert.equal(slots[0].reservedForLater, 5000);
  assert.equal(slots[1].canSell, 0);
  assert.equal(slots[1].short, 5000);
});

test("windowsFromBoardRow orders past → now → future", () => {
  const windows = windowsFromBoardRow(
    {
      pastCells: [
        {
          key: "2026-11-01",
          startDay: "01-11-2026",
          endDay: "05-11-2026",
          ready: 2000,
          booked: 0,
          net: 2000,
        },
      ],
      now: {
        key: "now",
        startDay: "14-11-2026",
        endDay: "18-11-2026",
        ready: 10000,
        booked: 8000,
        net: 2000,
      },
      cells: [
        {
          key: "2026-11-19",
          startDay: "19-11-2026",
          endDay: "23-11-2026",
          ready: 1000,
          booked: 4000,
          net: -3000,
        },
      ],
    },
    "2026-11-14"
  );
  assert.deepEqual(
    windows.map((w) => w.from),
    ["2026-11-01", "2026-11-14", "2026-11-19"]
  );
});

test("build + format digest shows can book date-wise", () => {
  const varieties = buildBookingCapacityVarieties(
    [
      {
        plantName: "Watermelon",
        subtypeName: "Sugar Baby",
        plantId: "p1",
        subtypeId: "s1",
        now: {
          key: "now",
          startDay: "14-11-2026",
          endDay: "18-11-2026",
          ready: 20000,
          booked: 10000,
          net: 10000,
        },
        cells: [
          {
            key: "2026-11-19",
            startDay: "19-11-2026",
            endDay: "23-11-2026",
            ready: 0,
            booked: 5000,
            net: -5000,
          },
        ],
        pastCells: [],
      },
    ],
    "2026-11-14"
  );
  assert.equal(varieties.length, 1);
  assert.equal(varieties[0].canBookTotal, 5000);
  assert.equal(varieties[0].slots[0].canSell, 5000);
  assert.equal(varieties[0].slots[0].reservedForLater, 5000);

  const formatted = formatBookingCapacityDigestMessages({
    varieties,
    today: "2026-11-14",
    tableDays: 30,
  });
  assert.equal(formatted.empty, false);
  assert.ok(formatted.chunks[0].includes("Booking capacity (FIFO)"));
  assert.ok(formatted.chunks[0].includes("Watermelon / Sugar Baby"));
  assert.ok(formatted.chunks[0].includes("can book"));
  assert.ok(formatted.chunks[0].includes("don't book") || formatted.chunks[0].includes("short"));
});
