import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDispatchOrderPlants,
  dispatchEntryLinkAdjustments,
  dispatchOrderChanges,
  plantsLoadedOnBatch,
  sowingEntryDispatchSet,
} from "../modules/sowingEntries/syncDispatchSowEntries.js";

const ORDER_X = "507f1f77bcf86cd799439011";
const ORDER_Y = "507f1f77bcf86cd799439012";
const BATCH_NEW = "507f1f77bcf86cd799439021";
const BATCH_OLD = "507f1f77bcf86cd799439022";

test("a changed sowing leaves the old entry and lands on the picked one", () => {
  const lines = [
    {
      bucket: "SWITCH",
      orderId: ORDER_X,
      batchId: BATCH_NEW,
      coverRehome: [{ fromBatchId: BATCH_OLD, plants: 1000 }],
      relinks: [{ orderId: ORDER_Y, fromBatchId: BATCH_NEW, toBatchId: BATCH_OLD, plants: 300 }],
      released: [{ batchId: BATCH_OLD, leftover: 200 }],
    },
  ];
  const sources = new Map([[ORDER_X, [{ batchId: BATCH_NEW, plants: 1000 }]]]);
  const { add, pull } = dispatchEntryLinkAdjustments(lines, sources);
  assert.ok(add.get(BATCH_NEW).has(ORDER_X));
  assert.ok(pull.get(BATCH_OLD).has(ORDER_X));
  assert.ok(pull.get(BATCH_NEW).has(ORDER_Y));
  assert.ok(add.get(BATCH_OLD).has(ORDER_Y));

  const set = sowingEntryDispatchSet(
    {
      _id: BATCH_NEW,
      orderCoveredPlants: 4000,
      excessPlants: 0,
      shownExcess: 0,
      plantsSowed: 25704,
      linkedOrderIds: [ORDER_Y],
      sowingDate: "26-10-2026",
    },
    BATCH_NEW,
    add,
    pull
  );
  assert.equal(set.bufferPlants, undefined);
  assert.equal(set.sowingBufferPct, undefined);
  assert.equal(set.orderCoveredPlants, 4000);
  assert.equal(set.excessPlants, 0);
  assert.equal(set.sowDay, "2026-10-26");
  assert.equal(set.dispatchedPlants, undefined);
  assert.equal(set.out, "");
  const ids = set.linkedOrderIds.map(String);
  assert.ok(ids.includes(ORDER_X));
  assert.equal(ids.includes(ORDER_Y), false);
});

test("only the plants on this load raise the new dispatch count", () => {
  const lines = [
    { batchId: BATCH_NEW, plants: 600, orderId: ORDER_X },
    { batchId: BATCH_OLD, plants: 50, orderId: ORDER_Y },
    { batchId: BATCH_NEW, plants: -20, orderId: ORDER_X },
  ];
  assert.equal(plantsLoadedOnBatch(lines, BATCH_NEW), 600);
  assert.equal(plantsLoadedOnBatch(lines, BATCH_OLD), 50);
  const next = applyDispatchOrderPlants(
    [{ orderId: ORDER_X, plants: 100 }],
    dispatchOrderChanges(lines, BATCH_NEW)
  );
  assert.deepEqual(next, [{ orderId: ORDER_X, plants: 700 }]);
  const unloaded = applyDispatchOrderPlants(next, [{ orderId: ORDER_X, plants: -700 }]);
  assert.deepEqual(unloaded, []);
});

test("an order kept on a selected sowing is not removed by another pick", () => {
  const { pull } = dispatchEntryLinkAdjustments([
    { bucket: "COVER", orderId: "a", batchId: "b1", released: [], relinks: [] },
    {
      bucket: "SWITCH",
      orderId: "a",
      batchId: "b2",
      released: [{ batchId: "b1", plants: 10 }],
      relinks: [],
    },
  ]);
  assert.equal(pull.get("b1"), undefined);
});

test("multiple picks each keep their own batch", () => {
  const { batchIds } = dispatchEntryLinkAdjustments([
    { bucket: "COVER", orderId: "a", batchId: "b1", coverRehome: [], relinks: [] },
    { bucket: "SWITCH", orderId: "a", batchId: "b2", coverRehome: [{ fromBatchId: "b3", plants: 10 }], relinks: [] },
  ], new Map([["a", [{ batchId: "b2", plants: 10 }]]]));
  assert.deepEqual([...batchIds].sort(), ["b1", "b2", "b3"]);
});
