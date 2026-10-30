import test from "node:test";
import assert from "node:assert/strict";
import { actualDispatchLegs, actualDispatchQty, buildStockLedger, currentStock } from "../utility/actualStock.js";

const AFTER = new Date("2026-10-05T00:00:00+05:30");
const at = (ymd) => new Date(`${ymd}T10:00:00+05:30`);
const changed = (ymd, s = "DISPATCHED") => [{ createdAt: at(ymd), newStatus: s }];

test("post-cutoff legs win, unload subtracts, earlier legs ignored", () => {
  const order = {
    orderStatus: "COMPLETED",
    numberOfPlants: 5000,
    dispatchHistory: [
      { date: at("2026-10-02"), quantity: 1000 },
      { date: at("2026-10-10"), quantity: 3000 },
      { date: at("2026-10-11"), quantity: 400, source: "SECONDARY_SHED_UNLOAD" },
    ],
  };
  assert.equal(actualDispatchQty(order, AFTER), 2600);
});

test("status change after cutoff: whole order gone before is 0, partial counts the balance", () => {
  const whole = { orderStatus: "DISPATCHED", numberOfPlants: 6000, dispatchHistory: [{ date: at("2026-09-28"), quantity: 6000 }], statusChanges: changed("2026-10-12") };
  assert.equal(actualDispatchQty(whole, AFTER), 0);
  const partial = { orderStatus: "DISPATCHED", numberOfPlants: 12000, dispatchHistory: [{ date: at("2026-09-28"), quantity: 10000 }], statusChanges: changed("2026-10-16") };
  assert.equal(actualDispatchQty(partial, AFTER), 2000);
  const fresh = { orderStatus: "COMPLETED", numberOfPlants: 4000, additionalPlants: 100, statusChanges: changed("2026-10-05", "COMPLETED") };
  assert.equal(actualDispatchQty(fresh, AFTER), 4100);
});

test("count day itself and other statuses are not actual dispatch", () => {
  const onCountDay = { orderStatus: "DISPATCHED", numberOfPlants: 900, statusChanges: changed("2026-10-04") };
  assert.equal(actualDispatchQty(onCountDay, AFTER), 0);
  const ready = { orderStatus: "READY_FOR_DISPATCH", numberOfPlants: 9100, statusChanges: changed("2026-10-10") };
  assert.equal(actualDispatchQty(ready, AFTER), 0);
});

test("legs carry IST days; partial fallback lands on the status-change day", () => {
  const order = {
    orderStatus: "COMPLETED",
    numberOfPlants: 5000,
    dispatchHistory: [
      { date: at("2026-10-10"), quantity: 3000 },
      { date: new Date("2026-10-10T20:00:00Z"), quantity: 400, source: "SECONDARY_SHED_UNLOAD" },
    ],
  };
  assert.deepEqual(actualDispatchLegs(order, AFTER), [{ day: "2026-10-10", qty: 3000 }, { day: "2026-10-11", qty: -400 }]);
  const partial = { orderStatus: "DISPATCHED", numberOfPlants: 12000, dispatchHistory: [{ date: at("2026-09-28"), quantity: 10000 }], statusChanges: changed("2026-10-16") };
  assert.deepEqual(actualDispatchLegs(partial, AFTER), [{ day: "2026-10-16", qty: 2000 }]);
});

test("ledger: opening, then daily in/out with running balance ending at current", () => {
  const rows = buildStockLedger({
    asOn: "2026-10-04",
    opening: 1000,
    lagwad: [{ day: "2026-10-06", qty: 500 }, { day: "2026-10-06", qty: 100 }],
    dispatch: [
      { day: "2026-10-05", qty: 300, orderId: 1, status: "DISPATCHED" },
      { day: "2026-10-06", qty: 50, orderId: 2, status: "COMPLETED" },
      { day: "2026-10-06", qty: 20, orderId: 2, status: "COMPLETED" },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.day, r.lagwad, r.dispatch, r.balance]), [
    ["2026-10-04", 0, 0, 1000],
    ["2026-10-05", 0, 300, 700],
    ["2026-10-06", 600, 70, 1230],
  ]);
  assert.equal(rows[2].lagwadCount, 2);
  assert.deepEqual(rows[2].orders, [{ orderId: 2, status: "COMPLETED", qty: 70 }]);
  assert.equal(rows.at(-1).balance, currentStock({ opening: 1000, lagwadAfter: 600, dispatchAfter: 370 }));
});

test("current = opening + lagwad after − dispatch after (banana 4 Oct)", () => {
  assert.equal(currentStock({ opening: 1162094, lagwadAfter: 607724, dispatchAfter: 431832 }), 1337986);
  assert.equal(currentStock({ opening: 76712, lagwadAfter: 0, dispatchAfter: 5604 }), 71108);
});
