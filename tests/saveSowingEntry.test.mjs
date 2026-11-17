import test from "node:test";
import assert from "node:assert/strict";
import {
  entryIrrelevantPatch,
  keepMarkedOld,
  sowingEntryFromBatch,
} from "../modules/sowingEntries/saveSowingEntry.js";

test("a new sowing with no batch percent uses the plant CMS percent", () => {
  const doc = sowingEntryFromBatch(
    {
      _id: "batch-1",
      sowingRequestId: "req-1",
      requestNumber: "SR1",
      sowingDate: "01-11-2026",
      plantReadyDate: "17-11-2026",
      plantsSowed: 26460,
      orderCoveredPlants: 23000,
    },
    { plantId: "plant-1", plantName: "Watermelon", subtypeId: "sub-1", subtypeName: "SImbha", year: 2026, cmsPct: 12 }
  );
  assert.equal(doc.sowDay, "2026-11-01");
  assert.equal(doc.sowingBufferPct, 12);
  assert.equal(doc.bufferPlants, 3175);
  assert.equal(doc.excessPlants, 285);
  assert.equal(doc.plantName, "Watermelon");
});

test("ready plants do not take the plant CMS percent", () => {
  const doc = sowingEntryFromBatch(
    {
      _id: "batch-2",
      plantsSowed: 1000,
      orderCoveredPlants: 0,
      noMortalityReserve: true,
      sowingBufferPct: 0,
      bufferPlants: 0,
    },
    { plantId: "plant-1", cmsPct: 12 }
  );
  assert.equal(doc.bufferPlants, 0);
  assert.equal(doc.excessPlants, 1000);
  assert.equal(doc.noMortalityReserve, true);
});

test("a dustbin mark stays old and drops stored excess", () => {
  const kept = keepMarkedOld({ isIrrelevant: false, excessPlants: 400 }, true);
  assert.equal(kept.isIrrelevant, true);
  assert.equal(kept.excessPlants, 0);
  const already = keepMarkedOld({ isIrrelevant: true, excessPlants: 0 }, true);
  assert.equal(already.excessPlants, 0);
  const fresh = keepMarkedOld({ isIrrelevant: false, excessPlants: 400 }, false);
  assert.equal(fresh.isIrrelevant, false);
  assert.equal(fresh.excessPlants, 400);
});

test("restoring an old entry puts the bookable excess back", () => {
  const marked = entryIrrelevantPatch(
    { plantsSowed: 1000, orderCoveredPlants: 0, sowingBufferPct: 0, noMortalityReserve: true },
    true
  );
  assert.equal(marked.isIrrelevant, true);
  assert.equal(marked.excessPlants, 0);
  const restored = entryIrrelevantPatch(
    {
      plantsSowed: 1000,
      orderCoveredPlants: 0,
      sowingBufferPct: 0,
      noMortalityReserve: true,
      isIrrelevant: true,
      excessPlants: 0,
    },
    false
  );
  assert.equal(restored.isIrrelevant, false);
  assert.equal(restored.excessPlants, 1000);
});

test("komb is stored as a kind and takes no mortality", () => {
  const doc = sowingEntryFromBatch(
    {
      _id: "batch-k",
      plantsSowed: 5000,
      entryKind: "komb",
      noMortalityReserve: true,
      sowingBufferPct: 0,
      bufferPlants: 0,
    },
    { plantId: "plant-1", cmsPct: 12 }
  );
  assert.equal(doc.entryKind, "komb");
  assert.equal(doc.bufferPlants, 0);
  assert.equal(doc.excessPlants, 5000);
});
