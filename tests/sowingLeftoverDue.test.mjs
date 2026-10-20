import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { leftoverBookingSlotIdSet, leftoverOrderIdSet } from "../services/sowingLeftoverDue.service.js";

describe("sowingLeftoverDue helpers export", () => {
  it("exports slot and order set loaders", () => {
    assert.equal(typeof leftoverBookingSlotIdSet, "function");
    assert.equal(typeof leftoverOrderIdSet, "function");
  });
});
