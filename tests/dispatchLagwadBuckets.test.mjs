import test from "node:test";
import assert from "node:assert/strict";
import {
  assignToWindow,
  bucketWindows,
  fillDispatch,
  fillLagwad,
  orderDueQty,
  parseWindowDays,
  summarize,
} from "../utility/dispatchLagwadBuckets.js";

const ist = (ymd) => new Date(`${ymd}T00:00:00+05:30`);

test("order due qty: status, dealer and vehicle loaded rules", () => {
  const base = { orderStatus: "ACCEPTED", numberOfPlants: 1000, additionalPlants: 50 };
  assert.equal(orderDueQty(base), 1050);
  assert.equal(orderDueQty({ ...base, remainingPlants: 400 }), 400);
  for (const s of ["DISPATCHED", "COMPLETED", "CANCELLED", "TEMPORARY_CANCELLED", "REJECTED", "PARTIALLY_COMPLETED"]) {
    assert.equal(orderDueQty({ ...base, orderStatus: s }), 0, s);
  }
  assert.equal(orderDueQty({ ...base, quotaSource: "dealer" }), 0);
  assert.equal(orderDueQty({ ...base, vehicleLoaded: true, vehicleLoadedQuantity: 300 }), 750);
  assert.equal(orderDueQty({ ...base, vehicleLoaded: true, vehicleLoadedQuantity: 0 }), 0);
  assert.equal(orderDueQty({ ...base, orderStatus: "FARM_READY" }), 1050);
});

test("windows: 5/10/15 day edges, last window clipped", () => {
  assert.equal(parseWindowDays("10"), 10);
  assert.equal(parseWindowDays("7"), 7);
  assert.equal(parseWindowDays("0"), 5);
  assert.equal(parseWindowDays("99"), 30);
  const w5 = bucketWindows("2026-11-01", "2026-11-30", 5);
  assert.equal(w5.length, 6);
  assert.deepEqual([w5[0].from, w5[0].to], ["2026-11-01", "2026-11-05"]);
  const w15 = bucketWindows("2026-11-01", "2026-11-20", 15);
  assert.deepEqual(w15.map((w) => [w.from, w.to]), [["2026-11-01", "2026-11-15"], ["2026-11-16", "2026-11-20"]]);
  assert.equal(bucketWindows("2026-11-10", "2026-11-01", 5).length, 0);
});

test("assign: past rolls into first window only when allowed", () => {
  const w = bucketWindows("2026-11-01", "2026-11-10", 5);
  assert.equal(assignToWindow(ist("2026-11-07"), w), 1);
  assert.equal(assignToWindow(ist("2026-10-20"), w), -1);
  assert.equal(assignToWindow(ist("2026-10-20"), w, { rollPast: true }), 0);
  assert.equal(assignToWindow(ist("2026-11-11"), w, { rollPast: true }), -1);
});

test("fill dispatch + lagwad with overdue and ready markers, then month totals", () => {
  const windows = bucketWindows("2026-10-29", "2026-11-12", 5);
  const opts = { rollPast: true, today: "2026-10-29" };
  fillDispatch(windows, [
    { orderStatus: "ACCEPTED", numberOfPlants: 500, deliveryDate: ist("2026-10-20") },
    { orderStatus: "PENDING", numberOfPlants: 200, deliveryDate: ist("2026-11-04") },
    { orderStatus: "DISPATCHED", numberOfPlants: 999, deliveryDate: ist("2026-11-04") },
  ], opts);
  fillLagwad(windows, [
    { availableQuantity: 800, expectedReadyDate: ist("2026-10-10").toISOString() },
    { availableQuantity: 300, expectedReadyDate: ist("2026-11-09").toISOString() },
    { availableQuantity: 0, expectedReadyDate: ist("2026-11-09").toISOString() },
  ], opts);
  assert.equal(windows[0].dispatch, 500);
  assert.equal(windows[0].overdueDispatch, 500);
  assert.equal(windows[0].lagwad, 800);
  assert.equal(windows[0].readyLagwad, 800);
  assert.equal(windows[0].oldLagwad, 800);
  assert.equal(windows[1].dispatch, 200);
  assert.equal(windows[2].lagwad, 300);
  assert.equal(windows[2].readyLagwad, 0);
  const { months, totals } = summarize(windows);
  assert.deepEqual(months.map((m) => m.month), ["2026-10", "2026-11"]);
  assert.equal(totals.dispatch, 700);
  assert.equal(totals.lagwad, 1100);
  assert.equal(totals.lineCount, 2);
});
