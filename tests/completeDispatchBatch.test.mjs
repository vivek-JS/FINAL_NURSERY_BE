import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveCompleteDispatchBatch,
  dispatchDetailForOrder,
} from "../services/completeDispatchBatch.service.js";

const oid = "6773f61461f4388d1bb59b7b";

test("dispatchDetailForOrder finds row by orderId", () => {
  const dispatch = {
    orderDispatchDetails: [
      { orderId: oid, shedLoadedBatches: [{ batchNumber: "B-1" }] },
    ],
  };
  const row = dispatchDetailForOrder(dispatch, oid);
  assert.equal(row?.shedLoadedBatches?.[0]?.batchNumber, "B-1");
});

test("single shedLoadedBatches forces vehicle snapshot (ignores client)", () => {
  const dispatch = {
    orderDispatchDetails: [
      {
        orderId: oid,
        shedLoadedBatches: [
          {
            batchNumber: "APP-99",
            pollyhouse: "PH-2",
            batchId: "507f1f77bcf86cd799439011",
            plants: 500,
          },
        ],
      },
    ],
  };
  const snap = resolveCompleteDispatchBatch({
    dispatch,
    orderId: oid,
    clientPayload: { batchNumber: "WRONG", batchSource: "manual" },
  });
  assert.equal(snap.batchNumber, "APP-99");
  assert.equal(snap.pollyhouse, "PH-2");
  assert.equal(snap.source, "vehicle_load");
});

test("no vehicle load requires batchNumber", () => {
  const dispatch = { orderDispatchDetails: [{ orderId: oid, shedLoadedBatches: [] }] };
  assert.throws(
    () =>
      resolveCompleteDispatchBatch({
        dispatch,
        orderId: oid,
        clientPayload: {},
      }),
    /Batch number is required/
  );
});

test("requiresPollyhouse when client flag set", () => {
  const dispatch = { orderDispatchDetails: [{ orderId: oid }] };
  assert.throws(
    () =>
      resolveCompleteDispatchBatch({
        dispatch,
        orderId: oid,
        clientPayload: {
          batchNumber: "B-1",
          requiresPollyhouse: true,
          pollyhouse: "",
        },
      }),
    /Shed selection is required/
  );
});

test("multiple vehicle loads must match client selection", () => {
  const dispatch = {
    orderDispatchDetails: [
      {
        orderId: oid,
        shedLoadedBatches: [
          { batchNumber: "A", pollyhouse: "S1", plants: 100 },
          { batchNumber: "B", pollyhouse: "S2", plants: 200 },
        ],
      },
    ],
  };
  assert.throws(
    () =>
      resolveCompleteDispatchBatch({
        dispatch,
        orderId: oid,
        clientPayload: { batchNumber: "Z" },
      }),
    /Select a batch that was loaded from the shed app/
  );
  const snap = resolveCompleteDispatchBatch({
    dispatch,
    orderId: oid,
    clientPayload: { batchNumber: "B", pollyhouse: "S2" },
  });
  assert.equal(snap.batchNumber, "B");
  assert.equal(snap.source, "vehicle_load");
});
