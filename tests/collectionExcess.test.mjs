import test from "node:test";
import assert from "node:assert/strict";
import { collectionExcessRows, releasedPlantsForEntry } from "../modules/sowingEntries/collectionExcess.js";

const docs = [
  {
    _id: "near",
    requestNumber: "SR-NEAR",
    plantReadyDate: "13-11-2026",
    sowDay: "2026-10-26",
    plantsSowed: 1000,
    orderCoveredPlants: 200,
    excessPlants: 400,
  },
  {
    _id: "far",
    requestNumber: "SR-FAR",
    plantReadyDate: "01-12-2026",
    excessPlants: 900,
  },
  {
    _id: "zero",
    requestNumber: "SR-ZERO",
    plantReadyDate: "13-11-2026",
    excessPlants: 0,
    sourceBatchId: "batch-a",
  },
];

test("only ready days inside the delivery window are free", () => {
  const data = collectionExcessRows(docs, {
    deliveryDate: "2026-11-13",
    windowDays: 3,
    pastWindowDays: 12,
  });
  assert.equal(data.totalFree, 400);
  assert.equal(data.entries.length, 1);
  assert.equal(data.entries[0].requestNumber, "SR-NEAR");
  assert.equal(data.entries[0].offsetDays, 0);
});

test("released cover on this order is free again", () => {
  const released = releasedPlantsForEntry(
    { sourceBatchId: "batch-a", requestNumber: "SR-ZERO" },
    [{ batchId: "batch-a", requestNumber: "SR-ZERO", plants: 250 }]
  );
  assert.equal(released, 250);
  const data = collectionExcessRows(docs, {
    deliveryDate: "2026-11-13",
    windowDays: 3,
    pastWindowDays: 12,
    releasedById: new Map([["zero", released]]),
  });
  const zero = data.entries.find((row) => row.entryId === "zero");
  assert.equal(zero.freePlants, 250);
  assert.equal(data.totalFree, 650);
});
