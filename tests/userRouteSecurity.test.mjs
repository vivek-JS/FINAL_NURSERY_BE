import { describe, it } from "node:test";
import assert from "node:assert/strict";
import userRouter from "../routes/user.route.js";

function findRoute(path, method) {
  return userRouter.stack.find((layer) => {
    const route = layer.route;
    return route?.path === path && route.methods?.[method];
  })?.route;
}

function runMiddleware(handler, user) {
  let statusCode = null;
  let payload = null;
  let nextCalled = false;
  const req = { user };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
  };

  handler(req, res, () => {
    nextCalled = true;
  });

  return { statusCode, payload, nextCalled };
}

describe("user route security", () => {
  it("dealer ledger repair requires SUPER_ADMIN after authentication", () => {
    const route = findRoute("/dealers/:dealerId/ledger/repair", "post");
    assert.ok(route, "repair route is registered");

    const handlers = route.stack.map((layer) => layer.handle);
    assert.equal(handlers[0].name, "authenticateToken");

    const denied = runMiddleware(handlers[1], { role: "ACCOUNTANT" });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.nextCalled, false);

    const allowed = runMiddleware(handlers[1], { role: "SUPER_ADMIN" });
    assert.equal(allowed.statusCode, null);
    assert.equal(allowed.nextCalled, true);
  });
});
