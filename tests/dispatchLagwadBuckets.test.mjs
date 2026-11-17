import test from "node:test";
import assert from "node:assert/strict";
import { splitLagwadQtyForSlot } from "../utility/lagwadSlotPlantsSplit.js";
import {
  assignToWindow,
  bucketWindows,
  fillDispatch,
  fillLagwad,
  lagwadBoardQty,
  fillUnbatchedAfter,
  orderDueQty,
  parseWindowDays,
  summarize,
} from "../utility/dispatchLagwadBuckets.js";

const ist = (ymd) => new Date(`${ymd}T00:00:00+05:30`);

test("lagwad in hand keeps 90 percent after 10 percent mortality", () => {
  const split = splitLagwadQtyForSlot(207424);
  assert.equal(split.expectedMortality, 20743);
  assert.equal(split.actualPlants, 186681);
});

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
  assert.equal(windows[0].lagwad, 720);
  assert.equal(windows[0].readyLagwad, 720);
  assert.equal(windows[0].oldLagwad, 720);
  assert.equal(windows[1].dispatch, 200);
  assert.equal(windows[2].lagwad, 270);
  assert.equal(windows[2].readyLagwad, 0);
  const { months, totals } = summarize(windows);
  assert.deepEqual(months.map((m) => m.month), ["2026-10", "2026-11"]);
  assert.equal(totals.dispatch, 700);
  assert.equal(totals.lagwad, 990);
  assert.equal(totals.lineCount, 2);
});

test("live count day keeps full plants; lagwad after it drops 10 percent mortality", () => {
  assert.equal(lagwadBoardQty({ availableQuantity: 1000 }, null), 900);
  assert.equal(lagwadBoardQty({ availableQuantity: 1000, inwardDate: ist("2026-10-04") }, "2026-10-04"), 1000);
  assert.equal(lagwadBoardQty({ availableQuantity: 1000, inwardDate: ist("2026-09-16") }, "2026-10-04"), 1000);
  assert.equal(lagwadBoardQty({ availableQuantity: 1000, inwardDate: ist("2026-10-05") }, "2026-10-04"), 900);
  const windows = bucketWindows("2026-11-08", "2026-11-12", 5);
  fillLagwad(windows, [
    { availableQuantity: 438924, inwardDate: ist("2026-09-30"), expectedReadyDate: ist("2026-10-20") },
    { availableQuantity: 10000, inwardDate: ist("2026-10-10"), expectedReadyDate: ist("2026-11-10") },
  ], { rollPast: true, today: "2026-11-08", liveCountAsOn: "2026-10-04" });
  assert.equal(windows[0].lagwad, 447924);
  assert.equal(windows[0].readyLagwad, 438924);
});

test("unbatched after the first window: 7 Nov counts, 6 Nov and a covered order do not", () => {
  const windows = bucketWindows("2026-11-02", "2026-12-01", 5);
  const due = { orderStatus: "ACCEPTED", remainingPlants: null };
  const orders = [
    { ...due, numberOfPlants: 1000, deliveryDate: ist("2026-11-06") },
    { ...due, numberOfPlants: 2500, deliveryDate: ist("2026-11-07") },
    { ...due, numberOfPlants: 9000, deliveryDate: ist("2026-11-08"), sowingDone: true },
    {
      ...due,
      numberOfPlants: 1000,
      deliveryDate: ist("2026-11-10"),
      sowingCoverSources: [{ plants: 400 }],
    },
    { ...due, numberOfPlants: 800, deliveryDate: ist("2026-11-12"), sowingPartialCover: [{ plants: 800 }] },
  ];
  fillDispatch(windows, orders, { rollPast: true, today: "2026-11-02" });
  fillUnbatchedAfter(windows, orders);
  assert.equal(windows[0].dispatch, 1000);
  assert.equal(windows[0].unbatchedAfter, 3100);
  assert.equal(windows[1].unbatchedAfter, 0);
});
