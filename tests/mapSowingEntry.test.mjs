import test from "node:test";
import assert from "node:assert/strict";
import { sowDayFrom, toSowingEntryListItem } from "../modules/sowingEntries/mapSowingEntry.js";

test("sow day accepts both date shapes", () => {
  assert.equal(sowDayFrom("26-10-2026"), "2026-10-26");
  assert.equal(sowDayFrom("2026-10-26"), "2026-10-26");
});

test("list item keeps mortality out of excess", () => {
  const item = toSowingEntryListItem({
    _id: "abc",
    requestNumber: "SR202610260017",
    plantName: "Watermelon",
    subtypeName: "Bhujang",
    plantsSowed: 25704,
    orderCoveredPlants: 22620,
    bufferPlants: 3084,
    excessPlants: 0,
    plantReadyDate: "13-11-2026",
    sowingDate: "26-10-2026",
    sowDay: "2026-10-26",
    sowingRequestId: "6adef72a193da2d6b84bc10d",
  });
  assert.equal(item.sowingRequestId, "6adef72a193da2d6b84bc10d");
  assert.equal(item.sowedQuantity, 25704);
  assert.equal(item.bookedPlants, 22620);
  assert.equal(item.excessPlants, 0);
  const stale = toSowingEntryListItem({
    plantsSowed: 25704,
    orderCoveredPlants: 22620,
    bufferPlants: 3084,
    excessPlants: 3084,
  });
  assert.equal(stale.excessPlants, 0);
  const cms = toSowingEntryListItem({
    plantsSowed: 26460,
    orderCoveredPlants: 23000,
    sowingBufferPct: 12,
    bufferPlants: 0,
    excessPlants: 3460,
  });
  assert.equal(cms.affectedSlot.batchExpectedMortality, 3175);
  assert.equal(cms.excessPlants, 285);
  assert.equal(item.affectedSlot.batchExpectedMortality, 3084);
  assert.equal(item.sowingDate, "2026-10-26");
  assert.equal(item.plantReadyDate, "13-11-2026");
});

test("cover column stops at saleable plants", () => {
  const item = toSowingEntryListItem({
    plantsSowed: 7812,
    orderCoveredPlants: 7000,
    sowingBufferPct: 12,
    bufferPlants: 937,
  });
  assert.equal(item.bookedPlants, 6875);
  assert.equal(item.excessPlants, 0);
  assert.equal(item.affectedSlot.batchExpectedMortality, 937);
});

test("cover column uses the order quantity when the stamp is the whole sow", () => {
  const item = toSowingEntryListItem(
    {
      plantsSowed: 15750,
      orderCoveredPlants: 15750,
      sowingBufferPct: 12,
      bufferPlants: 1890,
    },
    13500
  );
  assert.equal(item.bookedPlants, 13500);
  assert.equal(item.orderPlants, 13500);
  assert.equal(item.excessPlants, 360);
  const aboveReady = toSowingEntryListItem(
    {
      plantsSowed: 33642,
      orderCoveredPlants: 33642,
      sowingBufferPct: 12,
      bufferPlants: 4037,
    },
    30000
  );
  assert.equal(aboveReady.bookedPlants, 30000);
  assert.equal(aboveReady.excessPlants, 0);
});

test("list item keeps the komb tag", () => {
  const item = toSowingEntryListItem({
    plantsSowed: 5000,
    entryKind: "komb",
    noMortalityReserve: true,
    sowingBufferPct: 0,
    bufferPlants: 0,
    orderCoveredPlants: 0,
  });
  assert.equal(item.entryKind, "komb");
  assert.equal(item.sowedQuantity, 5000);
  assert.equal(item.affectedSlot.batchExpectedMortality, 0);
});
