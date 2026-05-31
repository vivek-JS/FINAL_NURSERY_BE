import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isOrderEligibleForPlantTransfer,
  isDealerScopedTransferPair,
  orderBelongsToDealerScope,
  ORDER_TRANSFER_EXCLUDED_STATUSES,
} from "../utility/orderTransferEligibility.js";

describe("orderTransferEligibility", () => {
  it("allows pipeline statuses except dispatched/completed/cancelled", () => {
    assert.equal(isOrderEligibleForPlantTransfer({ orderStatus: "ACCEPTED" }), true);
    assert.equal(isOrderEligibleForPlantTransfer({ orderStatus: "PENDING" }), true);
    assert.equal(isOrderEligibleForPlantTransfer({ orderStatus: "FARM_READY" }), true);
    assert.equal(isOrderEligibleForPlantTransfer({ orderStatus: "READY_FOR_DISPATCH" }), true);
  });

  it("blocks terminal statuses", () => {
    for (const st of ORDER_TRANSFER_EXCLUDED_STATUSES) {
      assert.equal(isOrderEligibleForPlantTransfer({ orderStatus: st }), false);
    }
  });

  it("treats dealer-booked farmer orders as dealer scope when dealerOrder is false", () => {
    const row = {
      dealerOrder: false,
      dealer: "6a1bbed6940ac57e9970507b",
      salesPerson: { _id: "6a1bbed6940ac57e9970507b", jobTitle: "DEALER" },
      orderStatus: "ACCEPTED",
    };
    assert.equal(orderBelongsToDealerScope(row), true);
    assert.equal(
      isDealerScopedTransferPair(row, { ...row, _id: "other", orderId: 2 }),
      true
    );
  });
});
