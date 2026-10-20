import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planOrderSowCover,
  applyIncompleteRequestRelease,
} from "../services/orderSowCover.plan.js";

const orders = (n, plants = 10000) =>
  Array.from({ length: n }, (_, i) => ({
    _id: `o${i + 1}`,
    numberOfPlants: plants,
    additionalPlants: 0,
  }));

describe("planOrderSowCover", () => {
  it("47k of 6x10k: 4 full, 7k partial on next, 1 waiting", () => {
    const p = planOrderSowCover({ plantsSowed: 47000, orders: orders(6) });
    assert.equal(p.full.length, 4);
    assert.equal(String(p.partial.orderId), "o5");
    assert.equal(p.partial.addPlants, 7000);
    assert.equal(p.partial.remaining, 3000);
    assert.equal(p.waiting.length, 1);
    assert.equal(String(p.waiting[0].orderId), "o6");
    assert.equal(p.waiting[0].remaining, 10000);
    assert.equal(p.excess, 0);
    assert.equal(p.incomplete, true);
    assert.equal(p.orderPlantsCovered, 47000);
  });

  it("exact 60k covers all, no incomplete", () => {
    const p = planOrderSowCover({ plantsSowed: 60000, orders: orders(6) });
    assert.equal(p.full.length, 6);
    assert.equal(p.partial, null);
    assert.equal(p.waiting.length, 0);
    assert.equal(p.excess, 0);
    assert.equal(p.incomplete, false);
  });

  it("70k covers all with 10k excess", () => {
    const p = planOrderSowCover({ plantsSowed: 70000, orders: orders(6) });
    assert.equal(p.full.length, 6);
    assert.equal(p.excess, 10000);
    assert.equal(p.incomplete, false);
  });

  it("next request covers leftover remaining after partial hold", () => {
    const list = [
      {
        _id: "o5",
        numberOfPlants: 10000,
        sowingPartialCover: [{ plants: 7000 }],
      },
      { _id: "o6", numberOfPlants: 10000 },
    ];
    const p = planOrderSowCover({ plantsSowed: 13000, orders: list });
    assert.equal(p.full.length, 2);
    assert.equal(p.full[0].plants, 3000);
    assert.equal(p.full[1].plants, 10000);
    assert.equal(p.incomplete, false);
    assert.equal(p.excess, 0);
  });
});

describe("applyIncompleteRequestRelease", () => {
  it("unlinks leftover orders including the partial leftover", () => {
    const req = { linkedOrderIds: ["o1", "o2", "o3", "o4", "o5", "o6"] };
    const plan = planOrderSowCover({ plantsSowed: 47000, orders: orders(6) });
    const r = applyIncompleteRequestRelease(req, plan, { sowedAt: new Date("2026-10-19") });
    assert.equal(r.incomplete, true);
    assert.equal(req.sowingIncomplete, true);
    assert.equal(req.sowingCompleted, true);
    assert.deepEqual(req.linkedOrderIds.map(String), ["o1", "o2", "o3", "o4"]);
    assert.deepEqual(req.uncoveredOrderIds.map(String), ["o5", "o6"]);
  });
});
