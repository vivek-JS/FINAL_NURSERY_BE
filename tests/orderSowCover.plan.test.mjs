import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planOrderSowCover,
  applyIncompleteRequestRelease,
  fillLastPartialFromBuffer,
  requestCoverOrderIds,
  orderPlantRemaining,
  canMarkOrderSowingDone,
  sowingStillNeedsMatch,
} from "../services/orderSowCover.plan.js";

const orders = (n, plants = 10000) =>
  Array.from({ length: n }, (_, i) => ({
    _id: `o${i + 1}`,
    numberOfPlants: plants,
    additionalPlants: 0,
  }));

describe("order cover enough-check", () => {
  it("remaining subtracts sowingCoverSources", () => {
    const o = {
      numberOfPlants: 12000,
      sowingCoverSources: [{ requestNumber: "SR1", plants: 1416 }],
    };
    assert.equal(orderPlantRemaining(o), 10584);
    assert.equal(canMarkOrderSowingDone(o), false);
    assert.equal(canMarkOrderSowingDone(o, 10584), true);
  });

  it("a done flag with no cover is still the full order", () => {
    const o = { numberOfPlants: 15000, sowingDone: true, sowingCoverSources: [] };
    assert.equal(orderPlantRemaining(o), 15000);
    assert.equal(canMarkOrderSowingDone(o), false);
  });

  it("a done flag with a short cover stays short", () => {
    const o = {
      numberOfPlants: 12500,
      sowingDone: true,
      sowingCoverSources: [{ plants: 11736 }],
    };
    assert.equal(orderPlantRemaining(o), 764);
    assert.equal(canMarkOrderSowingDone(o), false);
    assert.equal(canMarkOrderSowingDone(o, 764), true);
  });

  it("does not mark done when cover is short", () => {
    assert.equal(
      canMarkOrderSowingDone({ numberOfPlants: 2000, sowingCoverSources: [{ plants: 500 }] }, 1000),
      false
    );
    assert.equal(
      canMarkOrderSowingDone({ numberOfPlants: 2000, sowingCoverSources: [{ plants: 2000 }] }),
      true
    );
  });
});

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

  it("FIFO from actual 90035 covers 7 full + 13035 of 18000", () => {
    const list = [
      { _id: "4232", numberOfPlants: 8000 },
      { _id: "4111", numberOfPlants: 18000 },
      { _id: "3676", numberOfPlants: 10500 },
      { _id: "3677", numberOfPlants: 6000 },
      { _id: "4228", numberOfPlants: 6500 },
      { _id: "4242", numberOfPlants: 10000 },
      { _id: "4252", numberOfPlants: 18000 },
      { _id: "4257", numberOfPlants: 18000 },
      { _id: "4277", numberOfPlants: 17000 },
      { _id: "4081", numberOfPlants: 4200 },
    ];
    const p = planOrderSowCover({ plantsSowed: 90035, orders: list });
    assert.equal(p.full.length, 7);
    assert.equal(String(p.partial.orderId), "4257");
    assert.equal(p.partial.addPlants, 13035);
    assert.equal(p.partial.remaining, 4965);
    assert.equal(p.waiting.length, 2);
    assert.equal(p.orderPlantsCovered, 90035);
    assert.equal(p.excess, 0);
  });

  it("mortality leftover finishes 4257 (4965) without starting 4277", () => {
    const list = [
      { _id: "4232", numberOfPlants: 8000 },
      { _id: "4111", numberOfPlants: 18000 },
      { _id: "3676", numberOfPlants: 10500 },
      { _id: "3677", numberOfPlants: 6000 },
      { _id: "4228", numberOfPlants: 6500 },
      { _id: "4242", numberOfPlants: 10000 },
      { _id: "4252", numberOfPlants: 18000 },
      { _id: "4257", numberOfPlants: 18000 },
      { _id: "4277", numberOfPlants: 17000 },
      { _id: "4081", numberOfPlants: 4200 },
    ];
    const p = fillLastPartialFromBuffer(
      planOrderSowCover({ plantsSowed: 90035, orders: list }),
      12277
    );
    assert.equal(p.full.length, 8);
    assert.equal(String(p.full[7].orderId), "4257");
    assert.equal(p.full[7].plants, 18000);
    assert.equal(p.partial, null);
    assert.equal(p.waiting.length, 2);
    assert.equal(p.orderPlantsCovered, 95000);
    assert.equal(p.incomplete, true);
  });

  it("does not finish a partial larger than mortality leftover", () => {
    const p = fillLastPartialFromBuffer(
      planOrderSowCover({
        plantsSowed: 10000,
        orders: [
          { _id: "a", numberOfPlants: 8000 },
          { _id: "b", numberOfPlants: 18000 },
        ],
      }),
      2000
    );
    assert.equal(String(p.partial.orderId), "b");
    assert.equal(p.partial.remaining, 16000);
    assert.equal(p.full.length, 1);
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

describe("requestCoverOrderIds", () => {
  it("unions linked and uncovered", () => {
    assert.deepEqual(
      requestCoverOrderIds({
        linkedOrderIds: ["a", "b"],
        uncoveredOrderIds: ["b", "c"],
      }),
      ["a", "b", "c"]
    );
  });
});
