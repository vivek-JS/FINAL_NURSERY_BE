/**
 * CIB Registration Status / De-registration replies and the NEFT Incremental
 * Status API, using the sample packets from the CIB (without OTP) spec.
 *
 * @see modules/banking/services/iciciRegistration.service.js
 * @see modules/banking/services/iciciNeftStatus.service.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapRegistrationReply } from "../modules/banking/services/iciciRegistration.service.js";
import { mapBalanceReply } from "../modules/banking/services/iciciBalance.service.js";
import {
  applyNeftResult,
  mapNeftStatus,
} from "../modules/banking/services/iciciNeftStatus.service.js";

describe("Registration Status reply", () => {
  const cases = [
    [{ Status: "Registered", Response: "SUCCESS" }, "REGISTERED"],
    [{ Status: "Pending for Self Approval", Response: "SUCCESS" }, "PENDING_SELF_APPROVAL"],
    [{ Status: "Rejected", Response: "SUCCESS" }, "REJECTED"],
    [{ STATUS: "Deregistered", RESPONSE: "SUCCESS" }, "DEREGISTERED"],
    [{ Response: "FAILURE", ResponseCode: "9906", Message: "Aggregator Resgistration missing" }, "FAILURE"],
  ];
  for (const [raw, state] of cases) {
    it(`${raw.Status || raw.STATUS || raw.Message} → ${state}`, () => {
      assert.equal(mapRegistrationReply(raw).state, state);
    });
  }

  it("sandbox packets: Registered / invalid login", () => {
    assert.equal(mapRegistrationReply({ Status: "Registered", ResponseCode: "0000", RESPONSE: "Success" }).state, "REGISTERED");
    assert.equal(
      mapRegistrationReply({ Message: "Invalid login credentials.Please enter valid login credentials", Response: "Failure" }).state,
      "FAILURE"
    );
  });

  it("keeps the failure code for the UI", () => {
    const r = mapRegistrationReply({ Response: "FAILURE", ResponseCode: "9906" });
    assert.equal(r.code, "9906");
    assert.equal(r.response, "FAILURE");
  });
});

describe("NEFT Incremental Status reply", () => {
  const cases = [
    [{ STATUS: "Posted to RBI", UTRNUMBER: "N1", CreditDate: "", Response: "SUCCESS" }, "POSTED"],
    [{ STATUS: "Paid", UTRNUMBER: "N1", Response: "SUCCESS" }, "PAID"],
    [{ STATUS: "Amount credited to Beneficiary.", UTRNUMBER: "N1", Response: "SUCCESS" }, "CREDITED"],
    [{ STATUS: "Amount refunded to Remitter.", UTRNUMBER: "N1", Response: "SUCCESS", Reason: "ACCOUNT CLOSED" }, "REFUNDED"],
    [{ STATUS: "REVERSED", UTRNUMBER: "057262551", Response: "SUCCESS", REASON: "Invalid IFSC" }, "REVERSED"],
    [{ STATUS: "FAILURE", ErrorCode: "999922", Message: "Invalid Transaction Id.", Response: "Failure" }, "INVALID_UTR"],
    [{ STATUS: "FAILURE", ErrorCode: "1", Message: "Invalid AGGRID", Response: "Failure" }, "FAILURE"],
  ];
  for (const [raw, state] of cases) {
    it(`${raw.STATUS} ${raw.ErrorCode || ""} → ${state}`, () => {
      assert.equal(mapNeftStatus(raw).state, state);
    });
  }

  it("reads the refund reason and credit date", () => {
    const r = mapNeftStatus({
      STATUS: "Amount refunded to Remitter.",
      CreditDate: "05,02,2024 11:20:00 AM",
      Reason: "ACCOUNT DOES NOT EXIST",
    });
    assert.equal(r.reason, "ACCOUNT DOES NOT EXIST");
    assert.equal(r.creditDate, "05,02,2024 11:20:00 AM");
  });
});

describe("Balance Fetch reply (sandbox packet)", () => {
  it("reads EFFECTIVEBAL", () => {
    const r = mapBalanceReply(
      { ACCOUNTNO: "010205001809", DATE: "28/01/21 12:18:30", CURRENCY: "INR", EFFECTIVEBAL: "12032096.74", RESPONSE: "SUCCESS" },
      "010205001809"
    );
    assert.equal(r.availableBalance, 12032096.74);
    assert.equal(r.ledgerBalance, 12032096.74);
    assert.equal(r.bankDate, "28/01/21 12:18:30");
  });

  it("a Failure reply is an error, not a zero balance", () => {
    assert.throws(
      () => mapBalanceReply({ MESSAGE: "Invalid user access or account ID", RESPONSE: "Failure" }, "1"),
      /Invalid user access/
    );
  });
});

describe("applyNeftResult", () => {
  const payout = (status = "SUCCESS") => ({ status, bank: { utr: "N1" }, history: [] });

  it("a returned NEFT reverses a paid payout", () => {
    const doc = payout();
    const changed = applyNeftResult(doc, mapNeftStatus({ STATUS: "REVERSED", REASON: "Invalid IFSC" }));
    assert.equal(changed, true);
    assert.equal(doc.status, "REVERSED");
    assert.equal(doc.history.at(-1).toStatus, "REVERSED");
    assert.match(doc.bank.message, /Invalid IFSC/);
  });

  it("a credited NEFT only records the state", () => {
    const doc = payout();
    assert.equal(applyNeftResult(doc, mapNeftStatus({ STATUS: "Amount credited to Beneficiary." })), false);
    assert.equal(doc.status, "SUCCESS");
    assert.equal(doc.bank.neft.state, "CREDITED");
    assert.equal(doc.bank.neft.checks, 1);
    assert.equal(doc.history.length, 0);
  });

  it("never reverses a payout that is not SUCCESS", () => {
    const doc = payout("PROCESSING");
    assert.equal(applyNeftResult(doc, mapNeftStatus({ STATUS: "REVERSED" })), false);
    assert.equal(doc.status, "PROCESSING");
  });
});
