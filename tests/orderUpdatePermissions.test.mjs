import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getOrderUpdateUserContext,
  DISPATCH_MANAGER_ALLOWED_STATUSES,
  isDispatchManagerAllowedStatus,
} from "../utils/orderUpdatePermissions.js";

describe("orderUpdatePermissions", () => {
  it("dispatch manager: role DISPATCH_MANAGER with display jobTitle still edits core + allowed statuses", () => {
    const ctx = getOrderUpdateUserContext({
      role: "DISPATCH_MANAGER",
      jobTitle: "Manager",
    });
    assert.equal(ctx.canEditOrderCore, true);
    assert.equal(ctx.isDispatchManagerUser, true);
    assert.equal(ctx.canChangeOrderStatusFull, false);
    assert.equal(isDispatchManagerAllowedStatus("READY_FOR_DISPATCH"), true);
    assert.equal(isDispatchManagerAllowedStatus("CANCELLED"), false);
  });

  it("dispatch manager: jobTitle only (role default FARMER pattern)", () => {
    const ctx = getOrderUpdateUserContext({
      role: "FARMER",
      jobTitle: "DISPATCH_MANAGER",
    });
    assert.equal(ctx.canEditOrderCore, true);
    assert.equal(ctx.isDispatchManagerUser, true);
    assert.equal(ctx.userRole, "FARMER");
  });

  it("office admin has full status change", () => {
    const ctx = getOrderUpdateUserContext({
      role: "OFFICE_ADMIN",
      jobTitle: "OFFICE_ADMIN",
    });
    assert.equal(ctx.canChangeOrderStatusFull, true);
    assert.equal(ctx.canEditOrderCore, true);
  });

  it("super admin has full status change", () => {
    const ctx = getOrderUpdateUserContext({
      role: "SUPER_ADMIN",
    });
    assert.equal(ctx.canChangeOrderStatusFull, true);
  });

  it("accountant can edit core but not full status", () => {
    const ctx = getOrderUpdateUserContext({
      role: "ACCOUNTANT",
    });
    assert.equal(ctx.canEditOrderCore, true);
    assert.equal(ctx.canChangeOrderStatusFull, false);
  });

  it("null user is all false", () => {
    const ctx = getOrderUpdateUserContext(null);
    assert.equal(ctx.canEditOrderCore, false);
    assert.equal(ctx.isDispatchManagerUser, false);
    assert.equal(ctx.canChangeOrderStatusFull, false);
  });

  it("DISPATCH_MANAGER_ALLOWED_STATUSES includes expected values", () => {
    assert.equal(DISPATCH_MANAGER_ALLOWED_STATUSES.has("READY_FOR_DISPATCH"), true);
    assert.equal(DISPATCH_MANAGER_ALLOWED_STATUSES.has("DISPATCH_PROCESS"), true);
  });
});
