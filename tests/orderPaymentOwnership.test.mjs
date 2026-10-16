import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertCanAddPaymentToOrder } from "../services/orderPayment.service.js";

const SALES_A = "64a000000000000000000001";
const SALES_B = "64a000000000000000000002";
const DEALER_A = "64a000000000000000000003";

describe("assertCanAddPaymentToOrder", () => {
  it("sales: allowed on own order, blocked on another salesperson's order", () => {
    const user = { _id: SALES_A, jobTitle: "SALES" };
    assert.doesNotThrow(() => assertCanAddPaymentToOrder({ salesPerson: SALES_A }, user));
    assert.throws(
      () => assertCanAddPaymentToOrder({ salesPerson: SALES_B }, user),
      (err) => err.statusCode === 403
    );
  });

  it("dealer: allowed when order.dealer or order.salesPerson is the dealer", () => {
    const user = { _id: DEALER_A, jobTitle: "DEALER" };
    assert.doesNotThrow(() => assertCanAddPaymentToOrder({ dealer: DEALER_A, salesPerson: SALES_A }, user));
    assert.doesNotThrow(() => assertCanAddPaymentToOrder({ salesPerson: DEALER_A }, user));
    assert.throws(() => assertCanAddPaymentToOrder({ dealer: SALES_B, salesPerson: SALES_A }, user));
  });

  it("populated refs are compared by _id", () => {
    const user = { _id: SALES_A, jobTitle: "SALES" };
    assert.doesNotThrow(() => assertCanAddPaymentToOrder({ salesPerson: { _id: SALES_A } }, user));
  });

  it("other roles are unrestricted", () => {
    for (const jobTitle of ["ACCOUNTANT", "SUPER_ADMIN", "OFFICE_ADMIN", "DISPATCH_MANAGER"]) {
      assert.doesNotThrow(() =>
        assertCanAddPaymentToOrder({ salesPerson: SALES_B }, { _id: SALES_A, jobTitle })
      );
    }
  });
});
