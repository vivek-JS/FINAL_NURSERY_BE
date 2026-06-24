import { describe, it } from "node:test";
import assert from "node:assert/strict";
import AppError from "../utility/appError.js";
import {
  buildDispatchLinkClearedOrderPatch,
  orderStatusFromRemaining,
} from "../utils/orderDispatchStatus.js";

describe("orderDispatchStatus", () => {
  const baseOrder = {
    orderId: "ORD-1",
    numberOfPlants: 100,
    additionalPlants: 20,
  };

  it("keeps zero-remaining orders dispatched when clearing stale dispatch links", () => {
    assert.deepEqual(
      buildDispatchLinkClearedOrderPatch(
        { ...baseOrder, remainingPlants: 0 },
        { clearCurrentDispatchId: true }
      ),
      {
        currentDispatchId: null,
        orderStatus: "DISPATCHED",
      }
    );
  });

  it("uses ready only when all plants remain bookable", () => {
    assert.equal(orderStatusFromRemaining(baseOrder, 120), "READY_FOR_DISPATCH");
  });

  it("marks partial remaining quantities as in dispatch process", () => {
    assert.equal(orderStatusFromRemaining(baseOrder, 50), "DISPATCH_PROCESS");
  });

  it("rejects impossible remaining quantities", () => {
    assert.throws(
      () => orderStatusFromRemaining(baseOrder, 121),
      (err) => err instanceof AppError && err.statusCode === 400
    );
  });
});
