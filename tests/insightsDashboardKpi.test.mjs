import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildKpiOrderMatchStage } from "../controllers/insights.controller.js";

describe("insights dashboard KPI query", () => {
  it("uses deliveryDate window without constraining by booking date", () => {
    const match = buildKpiOrderMatchStage("2026-06-13");

    assert.equal(Object.hasOwn(match, "orderBookingDate"), false);
    assert.deepEqual(match.dealerOrder, false);
    assert.deepEqual(match.farmer, { $exists: true, $ne: null });
    assert.equal(match.deliveryDate.$ne, null);
    assert.equal(match.deliveryDate.$lte.toISOString(), "2026-06-20T18:29:59.999Z");
    assert.ok(match.orderStatus.$nin.includes("DISPATCHED"));
    assert.ok(match.orderStatus.$nin.includes("COMPLETED"));
    assert.equal(match.orderStatus.$nin.includes("READY_FOR_DISPATCH"), false);
  });
});
