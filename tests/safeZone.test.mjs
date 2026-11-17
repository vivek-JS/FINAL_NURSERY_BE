import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSafeZone,
  sowingEntryRemaining,
  orderSafeCover,
  orderCoverSowings,
  parseSafeZoneRange,
  parseSafeZoneTill,
  readyOnDay,
  sowingDayFigures,
  safeZoneDeliveryMatch,
  safeZoneOrders,
  sellableCoverPlants,
  expectedReadyPlants,
  readyDateKeys,
  readySowingRows,
  attachExpectedReady,
  withOverdue,
} from "../utility/safeZone.js";

const batch = {
  plantsSowed: 10000,
  sowingBufferPct: 10,
};

test("a 10% mortality reserve is not cover", () => {
  assert.equal(sellableCoverPlants(10000, batch), 9000);
  const cover = orderSafeCover(
    {
      numberOfPlants: 10000,
      sowingDone: false,
      sowingCoverSources: [{ batchId: "b1", plants: 10000 }],
    },
    new Map([["b1", batch]])
  );
  assert.equal(cover.covered, 9000);
  assert.equal(cover.mortality, 1000);
  assert.equal(cover.uncovered, 1000);
  assert.equal(cover.total, 10000);
});

test("sowingDone is fully covered and still listed", () => {
  const line = {
    orderId: "1",
    orderNumber: 11,
    farmerName: "Ravi",
    deliveryDate: "2026-11-15",
    plantId: "p",
    subtypeId: "s",
    plantName: "Papaya",
    subtypeName: "Taiwan",
    ...orderSafeCover(
      {
        numberOfPlants: 12000,
        sowingDone: true,
        sowingCoverSources: [{ batchId: "b1", plants: 12000 }],
      },
      new Map([["b1", batch]])
    ),
  };
  assert.equal(line.covered, 12000);
  assert.equal(line.uncovered, 0);
  assert.equal(line.mortality, 1200);
  assert.equal(line.total, 12000);
  assert.equal(safeZoneOrders([line]).length, 1);
  assert.equal(safeZoneOrders([line])[0].uncovered, 0);
});

test("an order with no sowing is uncovered and appears on tap", () => {
  const open = {
    orderId: "2",
    orderNumber: 22,
    farmerName: "Mina",
    deliveryDate: "2026-11-15",
    plantId: "p",
    subtypeId: "red",
    plantName: "Papaya",
    subtypeName: "Red Lady",
    ...orderSafeCover({ numberOfPlants: 8000, additionalPlants: 0, sowingDone: false }),
  };
  assert.equal(open.covered, 0);
  assert.equal(open.uncovered, 8000);
  const listed = safeZoneOrders([open]);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].farmerName, "Mina");
  assert.equal(listed[0].uncovered, 8000);
});

test("an order lists the sowing that covers it", () => {
  const covers = orderCoverSowings(
    {
      sowingCoverSources: [
        {
          batchId: "b1",
          plants: 10000,
          requestNumber: "12",
          shedName: "A",
          sowingDate: "01-10-2026",
          plantReadyDate: "15-11-2026",
        },
      ],
    },
    new Map([["b1", batch]])
  );
  assert.equal(covers.length, 1);
  assert.equal(covers[0].covered, 9000);
  assert.equal(covers[0].plantReadyDate, "2026-11-15");
  assert.equal(covers[0].shedName, "A");
});

test("partial cover without a batch counts as written", () => {
  const cover = orderSafeCover({
    numberOfPlants: 8000,
    sowingPartialCover: [{ plants: 5000 }],
  });
  assert.equal(cover.covered, 5000);
  assert.equal(cover.uncovered, 3000);
});

test("reversed cover is not cover", () => {
  const cover = orderSafeCover(
    {
      numberOfPlants: 4000,
      sowingCoverReversedAt: "2026-11-01",
      sowingCoverSources: [{ batchId: "b1", plants: 4000 }],
    },
    new Map([["b1", batch]])
  );
  assert.equal(cover.covered, 0);
  assert.equal(cover.uncovered, 4000);
});

test("an irrelevant batch covers nothing", () => {
  assert.equal(sellableCoverPlants(5000, { ...batch, isIrrelevant: true }), 0);
});

test("a stamped zero buffer does not hide a 10% reserve", () => {
  assert.equal(sellableCoverPlants(10000, { plantsSowed: 10000, sowingBufferPct: 10, bufferPlants: 0 }), 9000);
});

test("safe when nothing is uncovered, unsafe varieties sort first", () => {
  const board = buildSafeZone([
    {
      plantId: "p",
      subtypeId: "tw",
      plantName: "Papaya",
      subtypeName: "Taiwan",
      booked: 12000,
      covered: 12000,
      uncovered: 0,
    },
    {
      plantId: "p",
      subtypeId: "red",
      plantName: "Papaya",
      subtypeName: "Red Lady",
      booked: 8000,
      covered: 5000,
      uncovered: 3000,
    },
  ]);
  assert.equal(board.total, 20000);
  assert.equal(board.covered, 17000);
  assert.equal(board.mortality, 0);
  assert.equal(board.uncovered, 3000);
  assert.equal(board.safe, false);
  assert.equal(board.unsafeVarieties, 1);
  assert.equal(board.varieties[0].subtypeName, "Red Lady");
  assert.equal(board.varieties[0].safe, false);
  assert.equal(board.varieties[1].safe, true);
});

test("a variety with every order covered is safe", () => {
  const board = buildSafeZone([
    {
      plantId: "p",
      subtypeId: "tw",
      plantName: "Papaya",
      subtypeName: "Taiwan",
      booked: 12000,
      covered: 12000,
      uncovered: 0,
    },
  ]);
  assert.equal(board.safe, true);
  assert.equal(board.unsafeVarieties, 0);
  assert.equal(board.varieties[0].safe, true);
});

test("past due is the delivery that has gone, the rest is still due", () => {
  const board = buildSafeZone(
    [
      { plantId: "p", subtypeId: "s", plantName: "Watermelon", subtypeName: "Simbha", booked: 22000, total: 22000, covered: 22000, uncovered: 0, deliveryDate: "2026-11-04" },
      { plantId: "p", subtypeId: "s", plantName: "Watermelon", subtypeName: "Simbha", booked: 12000, total: 12000, covered: 12000, uncovered: 0, deliveryDate: "2026-11-07" },
    ],
    "2026-11-07"
  );
  assert.equal(board.pastDue, 22000);
  assert.equal(board.notDue, 12000);
  assert.equal(board.pastDueOrders, 1);
  assert.equal(board.notDueOrders, 1);
  assert.equal(board.varieties[0].pastDue, 22000);
  assert.equal(board.varieties[0].notDue, 12000);
});

test("sowing remaining is expected ready minus what is already out", () => {
  assert.equal(sowingEntryRemaining({ plantsSowed: 10000, sowingBufferPct: 10, dispatchedPlants: 2000 }), 7000);
  assert.equal(sowingEntryRemaining({ plantsSowed: 10000, isIrrelevant: true, dispatchedPlants: 0 }), 0);
});

test("orders with no plants are left out", () => {
  const board = buildSafeZone([{ plantId: "p", subtypeId: "s", booked: 0, covered: 0, uncovered: 0 }]);
  assert.equal(board.varieties.length, 0);
  assert.equal(board.safe, true);
});

test("till date keeps Accepted and Ready for dispatch, including a changed original date", () => {
  const till = parseSafeZoneTill("2026-11-06");
  const match = safeZoneDeliveryMatch(till);
  assert.deepEqual(match.orderStatus.$in, ["ACCEPTED", "READY_FOR_DISPATCH"]);
  assert.equal(match.$or[0].deliveryDate.$lte.getTime(), till.end.getTime());
  assert.equal(match.$or[1].oldDeliveryDate.$lte.getTime(), till.end.getTime());
  assert.equal(readyOnDay("06-11-2026", "2026-11-06"), true);
  assert.equal(readyOnDay("05-11-2026", "2026-11-06"), false);
  assert.deepEqual(sowingDayFigures(batch), { sowing: 10000, mortality: 1000 });
});

test("orders stay on the list even when the gap is zero, overdue date first", () => {
  const listed = safeZoneOrders([
    {
      orderId: "a",
      orderNumber: 2,
      farmerName: "Mina",
      deliveryDate: "2026-11-15",
      booked: 100,
      total: 100,
      covered: 100,
      mortality: 0,
      uncovered: 0,
      overdue: false,
    },
    {
      orderId: "b",
      orderNumber: 1,
      farmerName: "Ravi",
      bookingDate: "2026-10-02",
      deliveryDate: "2026-11-10",
      booked: 50,
      total: 50,
      covered: 50,
      mortality: 0,
      uncovered: 0,
      overdue: true,
    },
  ]);
  assert.deepEqual(
    listed.map((row) => row.deliveryDate),
    ["2026-11-10", "2026-11-15"]
  );
  assert.equal(listed[0].overdue, true);
  assert.equal(listed[0].bookingDate, "2026-10-02");
});

test("overdue stays beside the selected dates", () => {
  const range = buildSafeZone([
    {
      plantId: "p",
      subtypeId: "s",
      plantName: "Watermelon",
      subtypeName: "Slmbha",
      booked: 1000,
      total: 1000,
      covered: 800,
      mortality: 100,
      uncovered: 200,
    },
  ]);
  const overdue = buildSafeZone([
    {
      plantId: "p",
      subtypeId: "s",
      plantName: "Watermelon",
      subtypeName: "Slmbha",
      booked: 5000,
      total: 5000,
      covered: 4000,
      mortality: 500,
      uncovered: 1000,
    },
    {
      plantId: "p2",
      subtypeId: "s2",
      plantName: "Papaya",
      subtypeName: "Taiwan",
      booked: 300,
      total: 300,
      covered: 300,
      mortality: 0,
      uncovered: 0,
    },
  ]);
  const merged = withOverdue(range, overdue);
  assert.equal(merged.total, 1000);
  assert.equal(merged.uncovered, 200);
  assert.equal(merged.overdueTotal, 5300);
  assert.equal(merged.varieties[0].total, 1000);
  assert.equal(merged.varieties[0].overdueTotal, 5000);
  assert.equal(merged.varieties[0].safe, false);
  assert.equal(
    merged.varieties.some((row) => row.subtypeName === "Taiwan" && row.total === 0 && row.overdueTotal === 300),
    true
  );
});

test("date range rejects an inverted or oversized window", () => {
  assert.equal(parseSafeZoneRange("2026-11-20", "2026-11-15").error, "Pick a valid date range");
  assert.match(parseSafeZoneRange("2026-11-01", "2027-02-01").error, /62/);
  const ok = parseSafeZoneRange("2026-11-15", "2026-11-15");
  assert.equal(ok.from, "2026-11-15");
  assert.equal(ok.to, "2026-11-15");
  assert.ok(ok.start < ok.end);
});

test("expected ready plants are the sowing after the mortality reserve", () => {
  assert.equal(expectedReadyPlants(batch), 9000);
  assert.equal(expectedReadyPlants({ ...batch, isIrrelevant: true }), 0);
  assert.deepEqual(readyDateKeys({ from: "2026-11-15", to: "2026-11-16" }), ["15-11-2026", "16-11-2026"]);
  const board = attachExpectedReady(
    buildSafeZone([
      {
        plantId: "p",
        subtypeId: "s",
        plantName: "Watermelon",
        subtypeName: "Slmbha",
        booked: 1000,
        total: 1000,
        covered: 800,
        mortality: 100,
        uncovered: 200,
      },
    ]),
    new Map([
      ["p|s", 9000],
      ["p2|s2", 4000],
    ]),
    new Map([["p2|s2", { plantName: "Papaya", subtypeName: "Taiwan" }]])
  );
  assert.equal(board.ready, 13000);
  assert.equal(board.varieties[0].ready, 9000);
  assert.equal(board.varieties.some((row) => row.subtypeName === "Taiwan" && row.total === 0 && row.ready === 4000), true);
  const listed = readySowingRows([
    { _id: "b2", plantReadyDate: "16-11-2026", sowingDate: "01-10-2026", shedName: "A", requestNumber: "2", ...batch },
    { _id: "b1", plantReadyDate: "15-11-2026", sowingDate: "01-10-2026", shedName: "B", requestNumber: "1", ...batch, isIrrelevant: true },
    { _id: "b3", plantReadyDate: "15-11-2026", sowingDate: "02-10-2026", shedName: "C", requestNumber: "3", ...batch },
  ]);
  assert.deepEqual(
    listed.map((row) => row.batchId),
    ["b3", "b2"]
  );
  assert.equal(listed[0].plantReadyDate, "2026-11-15");
  assert.equal(listed[0].ready, 9000);
  assert.equal(listed[0].shedName, "C");
});
