import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isSalesOrDealerInsightsUser,
  normalizeRoleKey,
  requireInsightsAccess,
  scopedInsightsRole,
  userHasInsightsAccess,
} from "../utils/insightsAccess.js";
import {
  filterDispatchesByVisibleOrders,
  scopedOrderIdsForDispatch,
  sumDispatchPlantsForScope,
} from "../utils/insightsDispatchScope.js";

describe("insights access", () => {
  it("allows staff by jobTitle when role is the default FARMER", () => {
    const user = { role: "FARMER", jobTitle: "SALES" };
    assert.equal(userHasInsightsAccess(user), true);
    assert.equal(isSalesOrDealerInsightsUser(user), true);
    assert.equal(scopedInsightsRole(user), "SALES");
  });

  it("blocks plain farmer users from insights dashboards", () => {
    const user = { role: "FARMER", jobTitle: "" };
    assert.equal(userHasInsightsAccess(user), false);
    assert.equal(isSalesOrDealerInsightsUser(user), false);
  });

  it("normalizes role aliases used across the backend", () => {
    assert.equal(normalizeRoleKey("super admin"), "SUPER_ADMIN");
    assert.equal(userHasInsightsAccess({ role: "superadmin" }), true);
  });

  it("uses jobTitle before role for sales/dealer row scoping", () => {
    assert.equal(scopedInsightsRole({ role: "SALES", jobTitle: "DEALER" }), "DEALER");
  });

  it("normalizes scoped role onto req.user.jobTitle for legacy controllers", () => {
    const req = { user: { role: "SALES", jobTitle: "" } };
    let nextCalled = false;
    const res = {
      status() {
        throw new Error("status should not be called");
      },
    };

    requireInsightsAccess(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.user.jobTitle, "SALES");
  });
});

describe("insights dispatch scope", () => {
  it("filters dispatches and totals to visible orders in mixed trips", () => {
    const visible = new Set(["order-a"]);
    const dispatches = [
      {
        orderIds: ["order-a", "order-b"],
        plantsDetails: [{ plantId: "plant-1", totalPlants: 300 }],
        orderDispatchDetails: [
          { orderId: "order-a", dispatchQuantity: 120 },
          { orderId: "order-b", dispatchQuantity: 180 },
        ],
      },
      {
        orderIds: ["order-b"],
        plantsDetails: [{ plantId: "plant-2", totalPlants: 50 }],
      },
    ];

    const scoped = filterDispatchesByVisibleOrders(dispatches, visible);
    assert.equal(scoped.length, 1);
    assert.deepEqual(scopedOrderIdsForDispatch(scoped[0], visible), ["order-a"]);
    assert.equal(sumDispatchPlantsForScope(scoped[0], visible), 120);
  });

  it("does not expose aggregate plant totals for mixed legacy dispatches without per-order details", () => {
    const visible = new Set(["order-a"]);
    const dispatch = {
      orderIds: ["order-a", "order-b"],
      plantsDetails: [{ plantId: "plant-1", totalPlants: 300 }],
    };

    assert.equal(sumDispatchPlantsForScope(dispatch, visible), 0);
  });
});
