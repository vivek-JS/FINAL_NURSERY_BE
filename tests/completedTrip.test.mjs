import test from "node:test";
import assert from "node:assert/strict";
import { excludeDispatchIds, isCompletedTrip } from "../utility/completedTrip.js";

test("invoice or delivered trip is completed", () => {
  assert.equal(isCompletedTrip({ invoiceUrl: "https://files/inv.pdf" }), true);
  assert.equal(isCompletedTrip({ tripStatus: "delivered" }), true);
  assert.equal(isCompletedTrip({ tripStatus: "pending" }), false);
});

test("all orders completed closes the trip; one open order does not", () => {
  assert.equal(
    isCompletedTrip({ orderStatuses: ["COMPLETED", "PARTIALLY_COMPLETED"] }),
    true
  );
  assert.equal(isCompletedTrip({ orderStatuses: ["COMPLETED", "DISPATCHED"] }), false);
  assert.equal(isCompletedTrip({ orderStatuses: [] }), false);
});

test("excludeDispatchIds keeps a search id list", () => {
  const filter = { transportStatus: "LOADED", _id: { $in: ["a"] } };
  excludeDispatchIds(filter, ["done"]);
  assert.equal(filter._id, undefined);
  assert.deepEqual(filter.$and, [{ _id: { $in: ["a"] } }, { _id: { $nin: ["done"] } }]);
});
