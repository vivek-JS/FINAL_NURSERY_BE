import test from "node:test";
import assert from "node:assert/strict";
import { ORDER_EVENT_TYPES } from "../modules/orderEvents/domain/constants.js";
import {
  MIS_TRANSITION_RESOLUTION_ORDER,
  orderEventTypesForTransition,
  orderEventStatusValueMatch,
} from "../utility/misTransitionFromEvents.js";

test("MIS_TRANSITION_RESOLUTION_ORDER is events → statusChanges → legacy", () => {
  assert.deepEqual(MIS_TRANSITION_RESOLUTION_ORDER, [
    "order_event",
    "status_changes",
    "legacy_updated_at",
  ]);
});

test("orderEventTypesForTransition includes status changed + typed events", () => {
  const dispatched = orderEventTypesForTransition("DISPATCHED");
  assert.ok(dispatched.includes(ORDER_EVENT_TYPES.ORDER_STATUS_CHANGED));
  assert.ok(dispatched.includes(ORDER_EVENT_TYPES.ORDER_DISPATCHED));

  const completed = orderEventTypesForTransition("COMPLETED");
  assert.ok(completed.includes(ORDER_EVENT_TYPES.ORDER_COMPLETED));
});

test("orderEventStatusValueMatch filters ORDER_STATUS_CHANGED by newValue", () => {
  assert.ok(orderEventStatusValueMatch("DISPATCHED").$or);
});
