import test from "node:test";
import assert from "node:assert/strict";
import moment from "moment";
import {
  computeAvailablePlants,
  computeUtilizationPct,
  computeSlotAvailabilityStatus,
  buildAvailabilityOverviewRow,
  sortAvailabilityRows,
  summarizeAvailabilityRows,
  filterAvailabilityRows,
  filterNonPastAvailabilityRows,
  isAvailabilityRowPast,
} from "../utility/slotAvailabilityOverview.js";

test("computeAvailablePlants uses slot field when set", () => {
  assert.equal(computeAvailablePlants({ totalPlants: 1000, availablePlants: 250 }, 800), 250);
});

test("computeAvailablePlants falls back to capacity minus booked", () => {
  assert.equal(computeAvailablePlants({ totalPlants: 1000 }, 400), 600);
});

test("computeUtilizationPct caps at 100", () => {
  assert.equal(computeUtilizationPct(100, 150), 100);
  assert.equal(computeUtilizationPct(100, 50), 50);
});

test("computeSlotAvailabilityStatus detects overbooked and full", () => {
  assert.equal(
    computeSlotAvailabilityStatus({
      availablePlants: -10,
      totalPlants: 100,
      bookedPlants: 110,
      sowingAllowed: false,
    }),
    "overbooked"
  );
  assert.equal(
    computeSlotAvailabilityStatus({
      availablePlants: 0,
      totalPlants: 100,
      bookedPlants: 100,
      sowingAllowed: false,
    }),
    "full"
  );
  assert.equal(
    computeSlotAvailabilityStatus({
      availablePlants: 15,
      totalPlants: 100,
      bookedPlants: 85,
      sowingAllowed: false,
    }),
    "low"
  );
});

test("buildAvailabilityOverviewRow shape", () => {
  const row = buildAvailabilityOverviewRow({
    plantId: "p1",
    plantName: "Banana",
    subtypeId: "s1",
    subtypeName: "G-9",
    slot: {
      _id: "slot1",
      startDay: "01-05-2026",
      endDay: "07-05-2026",
      month: "May",
      totalPlants: 500,
    },
    bookedPlants: 200,
    sowingAllowed: false,
  });
  assert.equal(row.plantName, "Banana");
  assert.equal(row.availablePlants, 300);
  assert.equal(row.utilizationPct, 40);
  assert.equal(row.status, "ok");
  assert.equal(row.slotId, "slot1");
});

test("filterAvailabilityRows respects onlyAvailable and search", () => {
  const rows = [
    {
      plantId: "1",
      plantName: "Banana",
      subtypeName: "G-9",
      month: "May",
      availablePlants: 100,
    },
    {
      plantId: "2",
      plantName: "Papaya",
      subtypeName: "Red",
      month: "June",
      availablePlants: 0,
    },
  ];
  const only = filterAvailabilityRows(rows, { onlyAvailable: true });
  assert.equal(only.length, 1);
  assert.equal(only[0].plantName, "Banana");
  const searched = filterAvailabilityRows(rows, { search: "papaya" });
  assert.equal(searched.length, 1);
  assert.equal(searched[0].plantName, "Papaya");
});

test("sortAvailabilityRows orders by month then plant", () => {
  const sorted = sortAvailabilityRows([
    { month: "June", plantName: "B", subtypeName: "x", startDay: "01-06-2026" },
    { month: "May", plantName: "A", subtypeName: "x", startDay: "01-05-2026" },
  ]);
  assert.equal(sorted[0].month, "May");
});

test("filterNonPastAvailabilityRows drops ended slots", () => {
  const today = moment("15-06-2026", "DD-MM-YYYY", true).startOf("day");
  const rows = [
    { endDay: "10-06-2026", startDay: "01-06-2026" },
    { endDay: "20-06-2026", startDay: "16-06-2026" },
  ];
  assert.equal(isAvailabilityRowPast(rows[0], today), true);
  assert.equal(isAvailabilityRowPast(rows[1], today), false);
  const kept = filterNonPastAvailabilityRows(rows, today);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].endDay, "20-06-2026");
});

test("summarizeAvailabilityRows sums totals", () => {
  const s = summarizeAvailabilityRows([
    { totalPlants: 100, bookedPlants: 40, availablePlants: 60 },
    { totalPlants: 200, bookedPlants: 50, availablePlants: 150 },
  ]);
  assert.equal(s.totalCapacity, 300);
  assert.equal(s.booked, 90);
  assert.equal(s.available, 210);
  assert.equal(s.slotCount, 2);
});
