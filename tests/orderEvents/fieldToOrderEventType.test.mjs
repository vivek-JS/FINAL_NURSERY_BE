import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fieldToOrderEventType } from "../../modules/orderEvents/events/mapEditHistoryToEvents.js";
import { ORDER_EVENT_TYPES } from "../../modules/orderEvents/domain/constants.js";

describe("fieldToOrderEventType", () => {
  it("maps rate to ORDER_RATE_CHANGED", () => {
    assert.equal(fieldToOrderEventType("rate"), ORDER_EVENT_TYPES.ORDER_RATE_CHANGED);
  });

  it("maps numberOfPlants to ORDER_QUANTITY_CHANGED", () => {
    assert.equal(
      fieldToOrderEventType("numberOfPlants"),
      ORDER_EVENT_TYPES.ORDER_QUANTITY_CHANGED
    );
  });

  it("maps unknown field to ORDER_FIELD_CHANGED", () => {
    assert.equal(fieldToOrderEventType("unknownField"), ORDER_EVENT_TYPES.ORDER_FIELD_CHANGED);
  });
});
