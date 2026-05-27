import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEventPayloadFromEditEntry,
  buildStatusChangePayload,
} from "../../modules/orderEvents/events/mapEditHistoryToEvents.js";
import { ORDER_EVENT_TYPES } from "../../modules/orderEvents/domain/constants.js";

describe("backfill mapping helpers", () => {
  it("maps edit history rate entry", () => {
    const p = buildEventPayloadFromEditEntry({
      field: "rate",
      previousValue: 10,
      newValue: 12,
      notes: "Rate changed",
    });
    assert.equal(p.eventType, ORDER_EVENT_TYPES.ORDER_RATE_CHANGED);
    assert.equal(p.previousValue, 10);
    assert.equal(p.newValue, 12);
  });

  it("maps cancelled status", () => {
    const p = buildStatusChangePayload({
      previousStatus: "ACCEPTED",
      newStatus: "CANCELLED",
    });
    assert.equal(p.eventType, ORDER_EVENT_TYPES.ORDER_CANCELLED);
  });
});
