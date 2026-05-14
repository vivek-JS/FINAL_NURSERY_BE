import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { officialDcSequenceKey } from "../services/officialDeliveryChallan.service.js";

describe("officialDeliveryChallan.service", () => {
  it("officialDcSequenceKey is stable and unique per plant/subtype pair", () => {
    const a = "507f1f77bcf86cd799439011";
    const b = "507f191e810c19729de860ea";
    assert.equal(officialDcSequenceKey(a, b), `dc_ps:${a}:${b}`);
    assert.notEqual(officialDcSequenceKey(a, a), officialDcSequenceKey(a, b));
  });
});
