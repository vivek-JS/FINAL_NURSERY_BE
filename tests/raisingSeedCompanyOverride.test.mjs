import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompanySeedOverrideUpdate,
  validateCompanySeedOverrideSelection,
} from "../services/raisingSeedCompanyOverride.service.js";

const plantId = "691054dffba6fb380f8d5676";
const subtypeId = "6aa5625d0401ec99b9f6f60d";

function eligible(overrides = {}) {
  return {
    _id: "6aa700000000000000000001",
    orderId: 4001,
    plantName: plantId,
    plantSubtype: subtypeId,
    orderStatus: "ACCEPTED",
    sowingDone: false,
    sowingPlan: {
      seedSource: "RAISING",
      raisingSeedPackets: 12,
      raisingIntakeCollected: false,
      sowingNotes: "",
    },
    ...overrides,
  };
}

function validate(order, extras = {}) {
  return validateCompanySeedOverrideSelection({
    requestedIds: [String(order._id)],
    orders: [order],
    intakeOrderIds: [],
    activeRequestOrderIds: [],
    plantId,
    subtypeId,
    ...extras,
  });
}

test("accepts an active unsown uncollected raising order", () => {
  assert.equal(validate(eligible()).valid, true);
});

test("rejects the entire selection when one requested order is missing", () => {
  const result = validateCompanySeedOverrideSelection({
    requestedIds: [eligible()._id, "6aa700000000000000000002"],
    orders: [eligible()],
    plantId,
    subtypeId,
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0].reason, /not found/i);
});

test("rejects wrong subtype, completed sowing, and inactive status", () => {
  assert.equal(
    validate(eligible({ plantSubtype: "6aa5625d0401ec99b9f6f611" })).valid,
    false
  );
  assert.equal(validate(eligible({ sowingDone: true })).valid, false);
  assert.equal(validate(eligible({ orderStatus: "CANCELLED" })).valid, false);
});

test("rejects collected, linked, or already-requested farmer seed", () => {
  const order = eligible();
  assert.equal(
    validate(
      eligible({
        sowingPlan: {
          seedSource: "RAISING",
          raisingIntakeCollected: true,
        },
      })
    ).valid,
    false
  );
  assert.equal(
    validate(order, { intakeOrderIds: [String(order._id)] }).valid,
    false
  );
  assert.equal(
    validate(order, { activeRequestOrderIds: [String(order._id)] }).valid,
    false
  );
});

test("fails a multi-order batch when any selected order is unsafe", () => {
  const first = eligible();
  const second = eligible({
    _id: "6aa700000000000000000002",
    sowingPlan: {
      seedSource: "RAISING",
      raisingIntakeCollected: true,
    },
  });
  const result = validateCompanySeedOverrideSelection({
    requestedIds: [String(first._id), String(second._id)],
    orders: [first, second],
    plantId,
    subtypeId,
  });
  assert.equal(result.valid, false);
  assert.equal(result.requested.length, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].orderId, String(second._id));
});

test("builds company plan update and immutable audit entry", () => {
  const changedAt = new Date("2026-09-12T12:00:00.000Z");
  const update = buildCompanySeedOverrideUpdate(
    eligible(),
    "69ca549bc2ef331f5e13c91b",
    changedAt
  );

  assert.equal(update.$set["sowingPlan.seedSource"], "COMPANY");
  assert.equal(update.$set["sowingPlan.raisingSeedPackets"], 0);
  assert.equal(update.$set["sowingPlan.raisingIntakeCollected"], false);
  assert.equal(update.$push.orderEditHistory.field, "sowingPlan");
  assert.equal(
    update.$push.orderEditHistory.previousValue.seedSource,
    "RAISING"
  );
  assert.equal(update.$push.orderEditHistory.newValue.seedSource, "COMPANY");
});
