import { describe, it } from "node:test";
import assert from "node:assert/strict";
import router from "../routes/user.route.js";

function getRoute(path, method) {
  return router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods?.[method]
  )?.route;
}

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
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

describe("dealer ledger repair route authorization", () => {
  it("requires SUPER_ADMIN after authentication", () => {
    const route = getRoute("/dealers/:dealerId/ledger/repair", "post");
    assert.ok(route, "dealer ledger repair route is registered");
    assert.ok(route.stack.length >= 3, "route includes auth, role check, and controller");

    const roleMiddleware = route.stack[1].handle;
    const deniedRes = mockResponse();
    let deniedNextCalled = false;

    roleMiddleware({ user: { role: "SALES" } }, deniedRes, () => {
      deniedNextCalled = true;
    });

    assert.equal(deniedNextCalled, false);
    assert.equal(deniedRes.statusCode, 403);

    const allowedRes = mockResponse();
    let allowedNextCalled = false;

    roleMiddleware({ user: { role: "SUPER_ADMIN" } }, allowedRes, () => {
      allowedNextCalled = true;
    });

    assert.equal(allowedNextCalled, true);
    assert.equal(allowedRes.statusCode, 200);
  });
});
