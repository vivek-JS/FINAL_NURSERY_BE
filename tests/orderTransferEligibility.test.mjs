import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ORDER_TRANSFER_EXCLUDED_STATUSES,
  ORDER_TRANSFER_SEARCH_STATUS_QUERY,
  isOrderEligibleForPlantTransfer,
  getOrderTransferIneligibilityMessage,
  assertOrdersEligibleForPlantTransfer,
} from "../utility/orderTransferEligibility.js";

describe("orderTransferEligibility", () => {
  it("excludes DISPATCHED and COMPLETED", () => {
    assert.ok(ORDER_TRANSFER_EXCLUDED_STATUSES.includes("DISPATCHED"));
    assert.ok(ORDER_TRANSFER_EXCLUDED_STATUSES.includes("COMPLETED"));
    assert.equal(isOrderEligibleForPlantTransfer({ orderStatus: "DISPATCHED" }), false);
    assert.equal(isOrderEligibleForPlantTransfer({ orderStatus: "COMPLETED" }), false);
    assert.equal(isOrderEligibleForPlantTransfer({ orderStatus: "ACCEPTED" }), true);
    assert.equal(isOrderEligibleForPlantTransfer({ orderStatus: "FARM_READY" }), true);
  });

  it("search status query omits dispatched and completed", () => {
    const tokens = ORDER_TRANSFER_SEARCH_STATUS_QUERY.split(",");
    assert.ok(!tokens.includes("DISPATCHED"));
    assert.ok(!tokens.includes("COMPLETED"));
    assert.ok(tokens.includes("ACCEPTED"));
  });

  it("assertOrdersEligibleForPlantTransfer throws for ineligible source", () => {
    assert.throws(
      () =>
        assertOrdersEligibleForPlantTransfer(
          { orderId: 1, orderStatus: "DISPATCHED" },
          { orderId: 2, orderStatus: "ACCEPTED" }
        ),
      /Source order #1 is DISPATCHED/
    );
  });

  it("direct transfer controller enforces eligibility", () => {
    const src = readFileSync(
      resolve(process.cwd(), "controllers/farmerPlantOrderLedger.controller.js"),
      "utf8"
    );
    assert.match(src, /assertOrdersEligibleForPlantTransfer\(sourceOrder, targetOrder\)/);
  });
});
