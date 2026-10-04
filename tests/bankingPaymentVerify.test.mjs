/**
 * Bank verification of a single payment.
 *
 * @see modules/banking/services/reconciliationEngine.service.js — scoreMatch
 * @see modules/banking/services/paymentBankCheck.service.js — checkPaymentAgainstBank
 * @see models/bankStatementEntry.model.js — NOT_STATEMENT_VERIFIED
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  scoreMatch,
  qualifiesForAutoVerify,
  FUZZY_THRESHOLD,
} from "../modules/banking/services/reconciliationEngine.service.js";
import { NOT_STATEMENT_VERIFIED } from "../models/bankStatementEntry.model.js";
import { CHECK_RESULT } from "../modules/banking/services/paymentBankCheck.service.js";
import { normalizeMatchedBy } from "../modules/banking/services/verificationStatusEngine.js";

const UTR = "ICIC123456789012";
const ACCOUNT = "000405001234";
const PAY_DATE = "2026-09-20T00:00:00.000Z";

function payment(over = {}) {
  return {
    source: "order",
    orderMongoId: "507f1f77bcf86cd799439011",
    paymentId: "507f1f77bcf86cd799439012",
    orderId: 4521,
    farmerName: "Ram Lal",
    paidAmount: 25000,
    paymentDate: PAY_DATE,
    modeOfPayment: "NEFT/RTGS",
    utrNumber: UTR,
    paymentStatus: "PENDING",
    ...over,
  };
}

function statementLine(over = {}) {
  return {
    _id: "607f1f77bcf86cd7994390aa",
    accountNumber: ACCOUNT,
    txnDate: PAY_DATE,
    amount: 25000,
    referenceNumber: UTR,
    narration: "NEFT CR-RAM LAL",
    reconciliationStatus: "UNMATCHED",
    ...over,
  };
}

const readSource = (rel) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("scoreMatch — exact UTR and amount", () => {
  it("auto-verifies on UTR, amount and date", () => {
    const m = scoreMatch(payment(), statementLine());
    assert.ok(m, "expected a match");
    assert.ok(qualifiesForAutoVerify(m), `rule ${m.rule} should clear on its own`);
    assert.equal(m.matchType, "EXACT");
    assert.equal(m.rule, "UTR_AMOUNT_DATE");
  });

  it("scores 100 when the account number also agrees", () => {
    const m = scoreMatch(payment({ accountNumber: ACCOUNT }), statementLine());
    assert.equal(m.score, 100);
    assert.equal(m.rule, "UTR_AMOUNT_ACCOUNT_DATE");
  });

  it("matches on the bank line's utr field as well as referenceNumber", () => {
    const m = scoreMatch(payment(), statementLine({ referenceNumber: "", utr: UTR }));
    assert.ok(m);
    assert.equal(m.matchType, "EXACT");
  });

  it("scores a cheque on cheque number and amount, but will not clear it", () => {
    const m = scoreMatch(
      payment({ modeOfPayment: "Cheque", utrNumber: "", chequeNumber: "004412" }),
      statementLine({ referenceNumber: "", chequeNumber: "004412" })
    );
    assert.ok(m);
    assert.equal(m.rule, "CHEQUE_AMOUNT");
    assert.equal(qualifiesForAutoVerify(m), false, "a cheque has no UTR to agree on");
  });
});

describe("auto-verify policy — only UTR and amount clears a payment", () => {
  it("clears every UTR rule", () => {
    for (const rule of ["UTR_AMOUNT", "UTR_AMOUNT_DATE", "UTR_AMOUNT_ACCOUNT_DATE"]) {
      assert.equal(qualifiesForAutoVerify({ rule, matchType: "EXACT" }), true, rule);
    }
  });

  it("sends a transaction id match to suspense despite scoring 90", () => {
    const m = scoreMatch(
      payment({ utrNumber: "", transactionId: "BANKTXN99" }),
      statementLine({ referenceNumber: "", transactionId: "BANKTXN99" })
    );
    assert.equal(m.rule, "TXN_ID_AMOUNT");
    assert.equal(m.score, 90);
    assert.equal(qualifiesForAutoVerify(m), false);
  });

  it("sends every fuzzy rule to suspense", () => {
    for (const rule of ["AMOUNT_DATE", "AMOUNT_DATE_NARRATION", "AMOUNT_DATE_NARRATION_UTR"]) {
      assert.equal(qualifiesForAutoVerify({ rule, matchType: "FUZZY" }), false, rule);
    }
  });

  it("refuses a UTR rule that is not an EXACT match", () => {
    assert.equal(qualifiesForAutoVerify({ rule: "UTR_AMOUNT", matchType: "FUZZY" }), false);
  });

  it("refuses when there is no candidate at all", () => {
    for (const v of [null, undefined]) assert.equal(qualifiesForAutoVerify(v), false);
  });

  it("both the engine and the on-demand check use the one policy", () => {
    const engine = readSource("modules/banking/services/reconciliationEngine.service.js");
    const onDemand = readSource("modules/banking/services/paymentBankCheck.service.js");
    assert.match(engine, /if \(!qualifiesForAutoVerify\(best\)\)/);
    assert.match(onDemand, /if \(qualifiesForAutoVerify\(best\)\)/);
    for (const src of [engine, onDemand]) {
      assert.doesNotMatch(src, /AUTO_VERIFY_THRESHOLD/, "the score threshold must be gone");
    }
  });
});

describe("scoreMatch — amount is a hard gate", () => {
  it("rejects the same UTR at a different amount", () => {
    assert.equal(scoreMatch(payment(), statementLine({ amount: 24000 })), null);
  });

  it("rejects a one rupee difference", () => {
    assert.equal(scoreMatch(payment(), statementLine({ amount: 25001 })), null);
  });

  it("tolerates a sub-paisa difference from float arithmetic", () => {
    const m = scoreMatch(payment({ paidAmount: 25000.001 }), statementLine());
    assert.ok(m, "0.001 is inside the epsilon and should still match");
  });

  it("leaves the mismatch for checkPaymentAgainstBank to surface as AMOUNT_MISMATCH", () => {
    const src = readSource("modules/banking/services/paymentBankCheck.service.js");
    assert.match(src, /async function findUtrAmountMismatch/);
    assert.match(src, /reason: "AMOUNT_MISMATCH"/);
    assert.equal(CHECK_RESULT.AMOUNT_MISMATCH, "AMOUNT_MISMATCH");
  });
});

describe("scoreMatch — ambiguity", () => {
  it("gives two identical credits the same score, so neither wins", () => {
    const pay = payment({ utrNumber: "", transactionId: "" });
    const a = scoreMatch(pay, statementLine({ _id: "a", referenceNumber: "" }));
    const b = scoreMatch(pay, statementLine({ _id: "b", referenceNumber: "" }));
    assert.ok(a && b);
    assert.equal(a.score, b.score);
    assert.equal(qualifiesForAutoVerify(a), false, "a fuzzy amount-and-date match must not clear");
  });

  it("routes an equal-score tie to MULTIPLE_MATCH rather than guessing", () => {
    const src = readSource("modules/banking/services/paymentBankCheck.service.js");
    assert.match(
      src,
      /candidates\[0\]\.score === candidates\[1\]\.score[\s\S]{0,200}reason: "MULTIPLE_MATCH"/
    );
    assert.equal(CHECK_RESULT.MULTIPLE_MATCH, "MULTIPLE_MATCH");
  });

  it("drops anything below the fuzzy threshold", () => {
    const m = scoreMatch(
      payment({ utrNumber: "", paymentDate: "2026-09-01T00:00:00.000Z" }),
      statementLine()
    );
    assert.equal(m, null, `nothing within ${FUZZY_THRESHOLD} should survive a 19-day gap`);
  });
});

describe("normalizeMatchedBy — every engine rule fits the payment schema enum", () => {
  /** models/order.model.js — paymentSchema.bankVerificationMatchedBy */
  const ALLOWED = new Set(["UTR", "CHEQUE", "TXN_ID", "AMOUNT_DATE", null]);

  it("collapses each rule scoreMatch can produce", () => {
    const rules = {
      UTR_AMOUNT: "UTR",
      UTR_AMOUNT_DATE: "UTR",
      UTR_AMOUNT_ACCOUNT_DATE: "UTR",
      TXN_ID_AMOUNT: "TXN_ID",
      CHEQUE_AMOUNT: "CHEQUE",
      AMOUNT_DATE: "AMOUNT_DATE",
      AMOUNT_DATE_NARRATION: "AMOUNT_DATE",
      AMOUNT_DATE_NARRATION_UTR: "AMOUNT_DATE",
    };
    for (const [rule, expected] of Object.entries(rules)) {
      assert.equal(normalizeMatchedBy(rule), expected, `rule ${rule}`);
    }
  });

  it("maps the transaction status API onto UTR", () => {
    assert.equal(normalizeMatchedBy("TXN_STATUS_API"), "UTR");
  });

  it("passes through values that are already enum members", () => {
    for (const v of ["UTR", "CHEQUE", "TXN_ID", "AMOUNT_DATE"]) {
      assert.equal(normalizeMatchedBy(v), v);
    }
  });

  it("returns null rather than an invalid value for anything unknown", () => {
    for (const v of [null, undefined, "", "WHATEVER"]) {
      assert.equal(normalizeMatchedBy(v), null, `input ${JSON.stringify(v)}`);
    }
  });

  it("never produces a value the payment subdocument would reject", () => {
    const engine = readSource("modules/banking/services/reconciliationEngine.service.js");
    const rules = [...engine.matchAll(/rule = "([A-Z_]+)"/g)].map((m) => m[1]);
    assert.ok(rules.length >= 6, `expected to find the engine's rules, got ${rules.length}`);
    for (const rule of rules) {
      assert.ok(ALLOWED.has(normalizeMatchedBy(rule)), `${rule} normalised outside the enum`);
    }
  });

  it("the status engine writes the normalised value, not the raw rule", () => {
    const src = readSource("modules/banking/services/verificationStatusEngine.js");
    const writes = src.match(/subdoc\.bankVerificationMatchedBy = (\w+);/g) || [];
    assert.equal(writes.length, 2, "order and agriSales branches");
    for (const w of writes) {
      assert.match(w, /= matchedByEnum;/);
    }
  });
});

describe("statementVerified lines are retired from matching", () => {
  it("NOT_STATEMENT_VERIFIED excludes true and includes unset", () => {
    assert.deepEqual(NOT_STATEMENT_VERIFIED, { statementVerified: { $ne: true } });
  });

  it("the on-demand check applies it to its candidate query", () => {
    const src = readSource("modules/banking/services/paymentBankCheck.service.js");
    const candidateQueries = src.match(/BankStatementEntry\.find\(\{[\s\S]*?\}\)/g) || [];
    assert.ok(candidateQueries.length >= 2, "expected candidate and UTR-mismatch queries");
    for (const q of candidateQueries) {
      assert.match(q, /\.\.\.NOT_STATEMENT_VERIFIED/);
    }
  });

  it("the batch engine applies it too", () => {
    const src = readSource("modules/banking/services/reconciliationEngine.service.js");
    assert.match(src, /BankStatementEntry\.find\(\{[\s\S]*?\.\.\.NOT_STATEMENT_VERIFIED/);
  });

  it("marking a line verified is idempotent", () => {
    const src = readSource("modules/banking/services/bankStatement.service.js");
    assert.match(src, /alreadyVerified: true/);
  });
});

describe("verifying twice does not post a second entry", () => {
  it("an already-verified payment short-circuits before any write", () => {
    const src = readSource("modules/banking/services/paymentBankCheck.service.js");
    assert.match(src, /function alreadyVerified\(pay\)[\s\S]*?bankVerificationStatus === "BANK_VERIFIED"/);
    assert.match(src, /if \(alreadyVerified\(pay\)\)[\s\S]{0,200}alreadyVerified: true/);
  });

  it("the status engine refuses a payment that is not PENDING, for both sources", () => {
    const src = readSource("modules/banking/services/verificationStatusEngine.js");
    const guards = src.match(/paymentStatus !== "PENDING"/g) || [];
    assert.equal(guards.length, 2, "order and agriSales each need the PENDING guard");
    assert.match(src, /return \{ ok: false, error: "Payment not in PENDING state" \}/);
  });

  it("applyMatch bails on a failed transition before writing the cash book row", () => {
    const src = readSource("modules/banking/services/reconciliationEngine.service.js");
    const applyMatch = src.slice(src.indexOf("async function applyMatch"));
    const bailIdx = applyMatch.indexOf("if (!result.ok) return");
    const cashBookIdx = applyMatch.indexOf("CashBook.create");
    assert.ok(bailIdx > 0 && cashBookIdx > bailIdx, "the guard must precede the CashBook write");
  });

  it("a bank outage is reported as unreachable, never as NOT_FOUND", () => {
    const src = readSource("modules/banking/services/paymentBankCheck.service.js");
    assert.match(src, /code: "ICICI_UNREACHABLE"/);
    assert.equal(CHECK_RESULT.NOT_FOUND, "NOT_FOUND");
    assert.equal(CHECK_RESULT.VERIFIED, "VERIFIED");
  });
});

describe("no bank connection is not the same as a bank outage", () => {
  const src = () => readSource("modules/banking/services/paymentBankCheck.service.js");

  it("skips the live lookup entirely when ICICI is not configured", () => {
    // Otherwise the inquiry throws on missing credentials and a plain miss is
    // reported to the accountant as "Could not reach ICICI".
    assert.match(src(), /if \(allowLiveLookup && bankConfigured\)/);
    assert.match(src(), /function liveLookupAvailable\(\)[\s\S]{0,200}assertCorporateConfig\(\)/);
  });

  it("tells the accountant to import the statement instead", () => {
    assert.match(src(), /function notFoundMessage\(/);
    assert.match(src(), /Import the statement covering this date/);
    assert.match(src(), /message: notFoundMessage\(utr, bankConfigured\)/);
  });

  it("still reports a genuine outage as unreachable", () => {
    // The configured-but-failing path must keep its own error code.
    const live = src().slice(src().indexOf("if (allowLiveLookup && bankConfigured)"));
    assert.match(live, /catch \(err\)[\s\S]{0,400}code: "ICICI_UNREACHABLE"/);
  });
});
