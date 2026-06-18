import { describe, it } from "node:test";
import assert from "node:assert/strict";
import userRoute from "../routes/user.route.js";

function findRoute(path, method) {
  return userRoute.stack.find(
    (layer) => layer.route?.path === path && layer.route?.methods?.[method]
  )?.route;
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe("user route authorization", () => {
  it("restricts dealer ledger repair to super admins", () => {
    const route = findRoute("/dealers/:dealerId/ledger/repair", "post");
    assert.ok(route, "dealer ledger repair route should be registered");

    const handlers = route.stack.map((layer) => layer.handle);
    assert.equal(handlers[0].name, "authenticateToken");
    assert.equal(handlers.length, 3);

    const authorizeRepair = handlers[1];

    const deniedRes = createMockResponse();
    let deniedNextCalled = false;
    authorizeRepair(
      { user: { role: "ACCOUNTANT" } },
      deniedRes,
      () => {
        deniedNextCalled = true;
      }
    );
    assert.equal(deniedNextCalled, false);
    assert.equal(deniedRes.statusCode, 403);

    const allowedRes = createMockResponse();
    let allowedNextCalled = false;
    authorizeRepair(
      { user: { role: "SUPER_ADMIN" } },
      allowedRes,
      () => {
        allowedNextCalled = true;
      }
    );
    assert.equal(allowedNextCalled, true);
    assert.equal(allowedRes.statusCode, 200);
  });
});
