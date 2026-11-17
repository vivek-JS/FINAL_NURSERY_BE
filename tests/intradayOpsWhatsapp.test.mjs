import test from "node:test";
import assert from "node:assert/strict";
import {
  INTRADAY_WINDOW_MS,
  intradayWindowBounds,
  formatIntradayWindowLabels,
} from "../utility/intradayOpsWindow.js";
import { formatIntradayOpsEnglishMessages } from "../utility/intradayOpsEnglishFormat.js";

test("intraday window is 2.5 hours ending at to", () => {
  const to = new Date("2026-11-14T07:30:00.000Z"); // 1:00 PM IST
  const { from, to: end } = intradayWindowBounds(to);
  assert.equal(end.toISOString(), to.toISOString());
  assert.equal(end.getTime() - from.getTime(), INTRADAY_WINDOW_MS);
  assert.equal(INTRADAY_WINDOW_MS, 2.5 * 60 * 60 * 1000);
});

test("window labels use IST clock", () => {
  const to = new Date("2026-11-14T07:30:00.000Z"); // 13:00 IST
  const from = new Date(to.getTime() - INTRADAY_WINDOW_MS); // 10:30 IST
  const labels = formatIntradayWindowLabels(from, to);
  assert.equal(labels.fromLabel, "10:30");
  assert.equal(labels.toLabel, "13:00");
  assert.match(labels.rangeLabel, /10:30 – 13:00 IST/);
});

test("English formatter includes plant-wise dispatch totals", () => {
  const to = new Date("2026-11-14T07:30:00.000Z");
  const from = new Date(to.getTime() - INTRADAY_WINDOW_MS);
  const chunks = formatIntradayOpsEnglishMessages({
    from,
    to,
    bookingByPlant: [
      { label: "Banana / Grand Naine", plants: 8500, orders: 6 },
      { label: "Watermelon / Impact", plants: 12000, orders: 4 },
    ],
    bookingTotal: { plants: 20500, orders: 10 },
    dispatchGroups: [
      {
        label: "Banana / Grand Naine",
        plants: 6000,
        lines: [
          { shed: "Panhalgad", batch: "B-2410", plants: 4000 },
          { shed: "Kumbhi", batch: "B-2411", plants: 2000 },
        ],
      },
      {
        label: "Watermelon / Impact",
        plants: 9500,
        lines: [{ shed: "Panhalgad", batch: "W-1024", plants: 9500 }],
      },
    ],
    dispatchByPlant: [
      { plant: "Banana", plants: 6000 },
      { plant: "Watermelon", plants: 9500 },
    ],
    dispatchTotal: { plants: 15500 },
    salesperson: [
      {
        name: "Ramesh Patil",
        plants: 10200,
        amount: 255000,
        varieties: [
          { label: "Banana / Grand Naine", plants: 8500, amount: 170000 },
          { label: "Watermelon / Impact", plants: 1700, amount: 85000 },
        ],
      },
    ],
    salespersonTotal: { plants: 10200, amount: 255000 },
    payments: {
      collectedAmount: 185000,
      collectedCount: 9,
      pendingAmount: 420500,
      pendingCount: 28,
      pendingSamples: [{ label: "ORD-4012", farmerName: "Farmer X", amount: 45000 }],
    },
  });

  assert.equal(chunks.length, 1);
  const text = chunks[0];
  assert.match(text, /2\.5h Ops Report/);
  assert.match(text, /BOOKING \(Plant \/ Variety\)/);
  assert.match(text, /\*Banana \/ Grand Naine\*: 8,500 plants/);
  assert.match(text, /Panhalgad · Batch B-2410: 4,000/);
  assert.match(text, /Dispatched by plant:/);
  assert.match(text, /\*Banana\*: 6,000 plants/);
  assert.match(text, /\*Watermelon\*: 9,500 plants/);
  assert.match(text, /\*Grand total:\* 15,500 plants/);
  assert.match(text, /SALESPERSON/);
  assert.match(text, /– Banana \/ Grand Naine: 8,500 plants/);
  assert.match(text, /Collected \(this window\):/);
  assert.match(text, /Pending \(open\):/);
});

test("English day-end formatter uses daily title and today labels", () => {
  const to = new Date("2026-11-14T15:30:00.000Z"); // 9 PM IST
  const from = new Date("2026-11-13T18:30:00.000Z"); // midnight IST
  const [text] = formatIntradayOpsEnglishMessages({
    from,
    to,
    reportKind: "dayEnd",
    dateKey: "2026-11-14",
    bookingByPlant: [{ label: "Banana / G9", plants: 1000, orders: 1 }],
    bookingTotal: { plants: 1000, orders: 1 },
    dispatchGroups: [],
    dispatchByPlant: [],
    dispatchTotal: { plants: 0 },
    salesperson: [],
    salespersonTotal: { plants: 0, amount: 0 },
    payments: {
      collectedAmount: 5000,
      collectedCount: 1,
      pendingAmount: 10000,
      pendingCount: 1,
      pendingSamples: [],
    },
  });
  assert.match(text, /Daily Ops Summary/);
  assert.match(text, /full day IST/);
  assert.match(text, /Collected \(today\):/);
  assert.match(text, /none today/);
  assert.match(text, /ERP daily summary/);
});

test("English formatter handles empty window", () => {
  const to = new Date("2026-11-14T12:30:00.000Z");
  const from = new Date(to.getTime() - INTRADAY_WINDOW_MS);
  const [text] = formatIntradayOpsEnglishMessages({
    from,
    to,
    bookingByPlant: [],
    bookingTotal: { plants: 0, orders: 0 },
    dispatchGroups: [],
    dispatchByPlant: [],
    dispatchTotal: { plants: 0 },
    salesperson: [],
    salespersonTotal: { plants: 0, amount: 0 },
    payments: {
      collectedAmount: 12000,
      collectedCount: 1,
      pendingAmount: 408500,
      pendingCount: 27,
      pendingSamples: [],
    },
  });
  assert.match(text, /none in this window/);
  assert.match(text, /\*Collected \(this window\):\* ₹12,000/);
});
