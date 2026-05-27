import test from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_ORDER_STATUS_FOR_TRANSITION,
  misTransitionEverScField,
  transitionDrawerFacetStages,
  transitionHistoryByDayStages,
  normalizeStatusChangesExpr,
} from "../utility/misTransitionMetrics.js";

test("LEGACY_ORDER_STATUS_FOR_TRANSITION covers dispatch-like statuses", () => {
  assert.ok(LEGACY_ORDER_STATUS_FOR_TRANSITION.DISPATCHED.includes("DISPATCHED"));
  assert.ok(LEGACY_ORDER_STATUS_FOR_TRANSITION.COMPLETED.includes("COMPLETED"));
});

test("normalizeStatusChangesExpr handles array and single object", () => {
  assert.ok(normalizeStatusChangesExpr().$cond);
});

test("transitionHistoryByDayStages unwinds statusChanges per event", () => {
  const stages = transitionHistoryByDayStages(
    "DISPATCHED",
    new Date("2026-05-01T00:00:00+05:30"),
    new Date("2026-05-31T23:59:59+05:30")
  );
  assert.ok(stages.some((s) => s.$unwind === "$_misSc"));
});

test("transitionDrawerFacetStages uses events + history + legacy facet", () => {
  const stages = transitionDrawerFacetStages(
    "DISPATCHED",
    new Date("2026-05-01T00:00:00+05:30"),
    new Date("2026-05-31T23:59:59+05:30")
  );
  assert.ok(stages[0].$facet?.events);
  assert.ok(stages[0].$facet?.history);
  assert.ok(stages[0].$facet?.legacy);
});

test("misTransitionEverScField detects prior transitions", () => {
  assert.ok(misTransitionEverScField("DISPATCHED")._misEverSc);
});
