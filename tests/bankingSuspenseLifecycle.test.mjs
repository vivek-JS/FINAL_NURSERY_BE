/**
 * Batch reconciliation helpers behind the suspense queue.
 *
 * The database behaviour (rows opening, closing and staying closed across
 * runs) is covered end to end by scripts/test-banking-suspense-lifecycle.mjs.
 *
 * @see modules/banking/services/reconciliationEngine.service.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findUtrAmountMismatchIn,
  isPastNoMatchGrace,
  NO_MATCH_GRACE_DAYS,
} from "../modules/banking/services/reconciliationEngine.service.js";

const UTR = "ICIC123456789012";
const DAY = 24 * 60 * 60 * 1000;

describe("findUtrAmountMismatchIn", () => {
  const pay = { utrNumber: UTR, paidAmount: 3000 };

  it("finds a line with the same UTR at a different amount", () => {
    const line = { _id: "a", referenceNumber: UTR, amount: 3500 };
    assert.equal(findUtrAmountMismatchIn(pay, [line]), line);
  });

  it("reads the line's utr field when referenceNumber is blank", () => {
    const line = { _id: "a", referenceNumber: "", utr: UTR, amount: 2999 };
    assert.equal(findUtrAmountMismatchIn(pay, [line]), line);
  });

  it("ignores a line at the same amount — that is a match, not a mismatch", () => {
    assert.equal(findUtrAmountMismatchIn(pay, [{ referenceNumber: UTR, amount: 3000 }]), null);
  });

  it("ignores lines with a different UTR", () => {
    assert.equal(findUtrAmountMismatchIn(pay, [{ referenceNumber: "OTHER999999", amount: 1 }]), null);
  });

  it("needs a usable UTR on the payment", () => {
    for (const utrNumber of ["", "12345", undefined]) {
      assert.equal(
        findUtrAmountMismatchIn({ utrNumber, paidAmount: 3000 }, [{ referenceNumber: "12345", amount: 1 }]),
        null,
        `utr ${JSON.stringify(utrNumber)}`
      );
    }
  });
});

describe("isPastNoMatchGrace", () => {
  const now = new Date("2026-10-09T12:00:00.000Z");

  it("defaults to two days", () => {
    assert.equal(NO_MATCH_GRACE_DAYS, 2);
  });

  it("holds back a payment made inside the grace period", () => {
    const paymentDate = new Date(now.getTime() - 1.5 * DAY);
    assert.equal(isPastNoMatchGrace({ paymentDate }, now), false);
  });

  it("reports a payment once the grace period is over", () => {
    const paymentDate = new Date(now.getTime() - 2 * DAY);
    assert.equal(isPastNoMatchGrace({ paymentDate }, now), true);
  });

  it("never reports a payment with no usable date", () => {
    for (const paymentDate of [undefined, null, "not a date"]) {
      assert.equal(isPastNoMatchGrace({ paymentDate }, now), false);
    }
  });

  it("honours a custom grace period", () => {
    const paymentDate = new Date(now.getTime() - 3 * DAY);
    assert.equal(isPastNoMatchGrace({ paymentDate }, now, 5), false);
    assert.equal(isPastNoMatchGrace({ paymentDate }, now, 3), true);
  });
});
