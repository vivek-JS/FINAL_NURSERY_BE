import test from "node:test";
import assert from "node:assert/strict";
import {
  grossFromGridQty,
  sowEditDates,
} from "../modules/sowingEntries/editCollectionSowEntry.js";

test("ready date wins and lands 40 days after the sow day", () => {
  const dates = sowEditDates({
    sowDate: "2026-11-17",
    plantReadyDate: "2026-12-27",
    plantReadyDays: 40,
    fromSowDate: "10-11-2026",
    fromReadyDate: "20-12-2026",
  });
  assert.equal(dates.sowingDate, "17-11-2026");
  assert.equal(dates.sowDay, "2026-11-17");
  assert.equal(dates.readyDate, "27-12-2026");
  assert.equal(dates.readyDays, 40);
  assert.equal(dates.fromPlantReadyDays, 40);
});

test("ready days build the ready date when no ready date is sent", () => {
  const dates = sowEditDates({
    sowDate: "17-11-2026",
    plantReadyDays: 0,
  });
  assert.equal(dates.sowingDate, "17-11-2026");
  assert.equal(dates.readyDate, "17-11-2026");
  assert.equal(dates.readyDays, 0);
});

test("grid quantity keeps destroyed plants inside the stored sow", () => {
  assert.deepEqual(grossFromGridQty(2000, 50, 1950), { gross: 2000, changed: false });
  assert.deepEqual(grossFromGridQty(2000, 0, 1950), { gross: 1950, changed: true });
  assert.deepEqual(grossFromGridQty(1950, 0, 1950), { gross: 1950, changed: false });
});
