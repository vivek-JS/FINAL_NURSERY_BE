import assert from "node:assert/strict";
import test from "node:test";
import {
  fillBatchAllocations,
  sortBatchesByExpiry,
} from "../services/batchExpiryOrder.js";

const test1 = {
  _id: "t1",
  batchNumber: "Test 1",
  remainingQuantity: 20,
  expiryDate: "2026-01-01",
};
const test2 = {
  _id: "t2",
  batchNumber: "Test 2",
  remainingQuantity: 20,
  expiryDate: "2027-06-01",
};

test("FIFO fills the nearest-expiry batch first", () => {
  const filled = fillBatchAllocations([test2, test1], 20, "fifo");
  assert.deepEqual(filled, { t1: 20 });
  assert.deepEqual(
    sortBatchesByExpiry([test2, test1], "fifo").map((b) => b.batchNumber),
    ["Test 1", "Test 2"]
  );
});

test("latest-expiry fill prefers the farthest expiry", () => {
  const filled = fillBatchAllocations([test1, test2], 20, "latest");
  assert.deepEqual(filled, { t2: 20 });
});

test("FIFO spills leftover onto the next expiry", () => {
  const filled = fillBatchAllocations([test1, test2], 25, "fifo");
  assert.deepEqual(filled, { t1: 20, t2: 5 });
});
