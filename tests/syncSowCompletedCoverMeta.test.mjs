import test from "node:test";
import assert from "node:assert/strict";
import {
  syncSowCompletedCoverMeta,
  syncSowCompletedMetaFromBatch,
} from "../utility/syncSowCompletedCoverMeta.js";

function fakeDb({ events }) {
  let stored = { completionEvents: events, requestNumber: "SR1" };
  return {
    collection() {
      return {
        async findOne() {
          return stored;
        },
        async updateOne(_q, update) {
          const set = update.$set || {};
          for (const [k, v] of Object.entries(set)) {
            const m = k.match(/^completionEvents\.(\d+)\.meta$/);
            if (m) {
              const idx = Number(m[1]);
              stored = {
                ...stored,
                completionEvents: stored.completionEvents.map((e, i) =>
                  i === idx ? { ...e, meta: v } : e
                ),
              };
            }
          }
          return { modifiedCount: 1 };
        },
      };
    },
    _get() {
      return stored;
    },
  };
}

test("sync updates stale SOW_COMPLETED cover/excess meta", async () => {
  const db = fakeDb({
    events: [
      {
        type: "SOW_COMPLETED",
        meta: { orderCoveredPlants: 11022, excessPlants: 24762, remainingUncovered: 24762 },
      },
    ],
  });
  // any valid ObjectId string
  const requestId = "6ae2d3b190e7cac5dcfd7e67";
  const res = await syncSowCompletedCoverMeta(db, {
    requestId,
    orderCoveredPlants: 32022,
    excessPlants: 0,
    ordersMarked: 3,
    reason: "test",
  });
  assert.equal(res.updated, true);
  assert.equal(res.cover, 32022);
  assert.equal(res.excess, 0);
  const meta = db._get().completionEvents[0].meta;
  assert.equal(meta.orderCoveredPlants, 32022);
  assert.equal(meta.excessPlants, 0);
  assert.equal(meta.remainingUncovered, 0);
  assert.equal(meta.ordersMarked, 3);
});

test("sync from batch uses shownExcess", async () => {
  const db = fakeDb({
    events: [{ type: "SOW_COMPLETED", meta: { excessPlants: 99, orderCoveredPlants: 1 } }],
  });
  const res = await syncSowCompletedMetaFromBatch(db, {
    requestId: "6ae2d3b190e7cac5dcfd7e67",
    batch: {
      orderCoveredPlants: 5000,
      shownExcess: 0,
      excessPlants: 12,
      linkedOrderIds: ["a", "b"],
    },
    linkedOrderCount: 2,
  });
  assert.equal(res.updated, true);
  assert.equal(res.excess, 0);
  assert.equal(db._get().completionEvents[0].meta.ordersMarked, 2);
});

test("unchanged meta is a no-op", async () => {
  const db = fakeDb({
    events: [
      {
        type: "SOW_COMPLETED",
        meta: { orderCoveredPlants: 100, excessPlants: 0, remainingUncovered: 0 },
      },
    ],
  });
  const res = await syncSowCompletedCoverMeta(db, {
    requestId: "6ae2d3b190e7cac5dcfd7e67",
    orderCoveredPlants: 100,
    excessPlants: 0,
  });
  assert.equal(res.updated, false);
  assert.equal(res.reason, "unchanged");
});
