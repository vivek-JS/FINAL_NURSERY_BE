import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFreightInput,
  resolveFarmerFreightShare,
} from "../utils/orderFreight.js";
import { isDiscountPayment, DISCOUNT_PAYMENT_MODE } from "../utils/orderDiscountPayment.js";
import {
  DISPATCH_EXTRA_QTY_BY_ROLE,
  dispatchExtraQtyForUser,
  dispatchExtraQtyForRequest,
  maxDispatchQuantityForOrder,
} from "../utility/dispatchOrderStatus.util.js";

describe("orderFreight", () => {
  it("legacy number becomes 100% farmer share", () => {
    const out = normalizeFreightInput(500);
    assert.equal(out.freightCharges, 500);
    assert.equal(out.freight.farmerShareAmount, 500);
    assert.equal(out.freight.companyShareAmount, 0);
    assert.equal(out.freight.farmerSharePercent, 100);
    assert.equal(out.freight.paidBy, "FARMER");
  });

  it("50-50 split bills only the farmer share", () => {
    const out = normalizeFreightInput({
      totalAmount: 400,
      farmerSharePercent: 50,
      paidBy: "COMPANY",
      transporterName: "Patil",
    });
    assert.equal(out.freight.totalAmount, 400);
    assert.equal(out.freight.farmerShareAmount, 200);
    assert.equal(out.freight.companyShareAmount, 200);
    assert.equal(out.freightCharges, 200);
    assert.equal(out.freight.paidBy, "COMPANY");
    assert.equal(out.freight.transporterName, "Patil");
  });

  it("resolveFarmerFreightShare prefers structured farmer share over legacy", () => {
    assert.equal(
      resolveFarmerFreightShare({
        freightCharges: 999,
        freight: { farmerShareAmount: 150, totalAmount: 400 },
      }),
      150
    );
    assert.equal(resolveFarmerFreightShare({ freightCharges: 80 }), 80);
  });
});

describe("orderDiscountPayment", () => {
  it("detects Discount mode and isDiscount flag", () => {
    assert.equal(isDiscountPayment({ modeOfPayment: DISCOUNT_PAYMENT_MODE }), true);
    assert.equal(isDiscountPayment({ isDiscount: true, modeOfPayment: "Cash" }), true);
    assert.equal(isDiscountPayment({ modeOfPayment: "UPI" }), false);
  });
});

describe("dispatch extra quantity by role", () => {
  it("uses 1000 / 500 / 1000 limits", () => {
    assert.equal(DISPATCH_EXTRA_QTY_BY_ROLE.DISPATCH_MANAGER, 1000);
    assert.equal(DISPATCH_EXTRA_QTY_BY_ROLE.OFFICE_ADMIN, 500);
    assert.equal(DISPATCH_EXTRA_QTY_BY_ROLE.SUPER_ADMIN, 1000);
  });

  it("reads office admin from jobTitle even when role is FARMER", () => {
    assert.equal(dispatchExtraQtyForUser({ role: "FARMER", jobTitle: "OFFICE_ADMIN" }), 500);
    assert.equal(dispatchExtraQtyForUser({ jobTitle: "SUPER_ADMIN" }), 1000);
    assert.equal(dispatchExtraQtyForUser({ role: "ACCOUNTANT" }), 0);
  });

  it("adds extra onto remaining for max dispatch qty", () => {
    const req = { user: { jobTitle: "OFFICE_ADMIN" } };
    assert.equal(dispatchExtraQtyForRequest(req), 500);
    assert.equal(maxDispatchQuantityForOrder(100, req), 600);
  });
});
