import test from "node:test";
import assert from "node:assert/strict";
import { buildMisMobileRows, forecastDates, parseForecastDays } from "../services/misMobile.service.js";

const dates = forecastDates("2026-10-16", 3);

test("forecast dates start today", () => {
  assert.deepEqual(dates, ["2026-10-16", "2026-10-17", "2026-10-18"]);
  assert.equal(parseForecastDays(undefined), 5);
  assert.equal(parseForecastDays("99"), 10);
  assert.equal(parseForecastDays("0"), 5);
});

test("variety rows merge booked/out with the per-day forecast", () => {
  const varietyTable = [
    {
      plantId: "p1",
      subtypeId: "s1",
      plantName: "Banana",
      subtype: "G9",
      booking: { orders: 4, plants: 31252 },
      delivery: { dispatched: { orders: 3, plants: 10000 } },
    },
    { plantId: "p2", subtypeId: "s2", plantName: "Chilli", subtype: "Talwar", booking: { orders: 0, plants: 0 }, delivery: {} },
  ];
  const forecastRows = [
    { plantId: "p1", subtypeId: "s1", plantName: "Banana", subtypeName: "G9", date: "2026-10-16", orders: 2, plants: 12000 },
    { plantId: "p1", subtypeId: "s1", plantName: "Banana", subtypeName: "G9", date: "2026-10-18", orders: 1, plants: 500 },
    { plantId: "p3", subtypeId: "s3", plantName: "Papaya", subtypeName: "15 No", date: "2026-10-17", orders: 1, plants: 900 },
    { plantId: "p3", subtypeId: "s3", plantName: "Papaya", subtypeName: "15 No", date: "2026-11-30", orders: 1, plants: 77 },
  ];

  const { rows, totals } = buildMisMobileRows(varietyTable, forecastRows, dates);

  assert.deepEqual(
    rows.map((row) => [row.plantName, row.subtypeName, row.booked.plants, row.out.plants, row.forecast.map((d) => d.plants), row.forecastTotal]),
    [
      ["Banana", "G9", 31252, 10000, [12000, 0, 500], 12500],
      ["Papaya", "15 No", 0, 0, [0, 900, 0], 900],
    ]
  );
  assert.equal(totals.booked, 31252);
  assert.equal(totals.out, 10000);
  assert.deepEqual(totals.forecast.map((d) => d.plants), [12000, 900, 500]);
  assert.equal(totals.forecastTotal, 13400);
});
