import assert from "node:assert/strict";
import test from "node:test";
import { validateLinkedOrderScope } from "../utility/sowingRequestOrderScope.js";

const plantId = "691054dffba6fb380f8d5676";
const subtypeId = "6aa5625d0401ec99b9f6f60d";

function eligible(overrides = {}) {
  return {
    _id: "6aa700000000000000000001",
    plantName: plantId,
    plantSubtype: subtypeId,
    bookingSlot: "6bb700000000000000000001",
    orderStatus: "ACCEPTED",
    sowingDone: false,
    ...overrides,
  };
}

function validate(
  orders,
  requestedOrderIds = orders.map((order) => order._id)
) {
  return validateLinkedOrderScope({
    requestedOrderIds,
    orders,
    plantId,
    subtypeId,
  });
}

test("rejects missing selected orders", () => {
  const result = validate(
    [eligible()],
    [eligible()._id, "6aa700000000000000000002"]
  );

  assert.equal(result.valid, false);
  assert.deepEqual(result.missingOrderIds, ["6aa700000000000000000002"]);
});

test("rejects orders for a different plant or subtype", () => {
  assert.equal(
    validate([eligible({ plantName: "6aa700000000000000000099" })]).valid,
    false
  );
  assert.equal(
    validate([eligible({ plantSubtype: "6aa700000000000000000099" })]).valid,
    false
  );
});

test("rejects completed or inactive orders", () => {
  assert.equal(validate([eligible({ sowingDone: true })]).valid, false);
  assert.equal(validate([eligible({ orderStatus: "CANCELLED" })]).valid, false);
});

test("derives unique slots only from validated linked orders", () => {
  const result = validate([
    eligible(),
    eligible({ _id: "6aa700000000000000000002" }),
    eligible({
      _id: "6aa700000000000000000003",
      bookingSlot: "6bb700000000000000000002",
    }),
  ]);

  assert.equal(result.valid, true);
  assert.deepEqual(result.linkedSlotIds, [
    "6bb700000000000000000001",
    "6bb700000000000000000002",
  ]);
});
