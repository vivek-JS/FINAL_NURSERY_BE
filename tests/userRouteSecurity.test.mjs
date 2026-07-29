import { describe, it } from "node:test";
import assert from "node:assert/strict";
import userRouter from "../routes/user.route.js";

function makeResponse() {
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

describe("user route security", () => {
  it("dealer ledger repair is super-admin only after authentication", () => {
    const layer = userRouter.stack.find(
      (entry) =>
        entry.route?.path === "/dealers/:dealerId/ledger/repair" &&
        entry.route?.methods?.post
    );
    assert.ok(layer, "repair route exists");

    const handlers = layer.route.stack.map((entry) => entry.handle);
    assert.equal(handlers[0].name, "authenticateToken");
    assert.equal(handlers.length, 3);

    const authorizeSuperAdmin = handlers[1];
    const blockedRes = makeResponse();
    let blockedNext = false;
    authorizeSuperAdmin({ user: { role: "ACCOUNTANT" } }, blockedRes, () => {
      blockedNext = true;
    });
    assert.equal(blockedRes.statusCode, 403);
    assert.equal(blockedNext, false);

    const allowedRes = makeResponse();
    let allowedNext = false;
    authorizeSuperAdmin({ user: { role: "SUPER_ADMIN" } }, allowedRes, () => {
      allowedNext = true;
    });
    assert.equal(allowedNext, true);
  });
});
