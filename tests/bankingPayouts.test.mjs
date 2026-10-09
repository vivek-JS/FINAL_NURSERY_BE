/**
 * Payout (maker-checker) rules that do not need a database: input validation
 * as ICICI judges it, payee register checks, bank answer → payout status,
 * reference format, roles.
 *
 * The full flow is covered by scripts/test-banking-payouts.mjs.
 *
 * @see modules/banking/services/iciciPayout.service.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generatePayoutUniqueId,
  ICICI_FT_IFSC,
  isPayoutChecker,
  mapBankResult,
  maskAccount,
  validatePayoutInput,
} from "../modules/banking/services/iciciPayout.service.js";
import {
  bankKindOf,
  validateBeneficiaryInput,
} from "../modules/banking/services/iciciBeneficiary.service.js";
import {
  beneficiaryRowToInput,
  normaliseMode,
  payoutRowToInput,
} from "../modules/banking/services/payoutBulk.service.js";

const DEBIT = "000405001234";
const base = {
  txnType: "RGS",
  payeeName: "ABC Traders",
  accountNumber: "50100012345678",
  ifsc: "HDFC0001234",
  amount: "12500.50",
  remarks: "Invoice 4471",
  purpose: "VENDOR_BILL",
  payeeType: "VENDOR",
};
const validate = (patch = {}) => validatePayoutInput({ ...base, ...patch }, { debitAccount: DEBIT });

describe("validatePayoutInput", () => {
  it("accepts a normal NEFT payment and normalises it", () => {
    const r = validate({ ifsc: "hdfc0001234", accountNumber: "5010 0012 345678", payeeName: "  ABC   Traders " });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.value.payee.ifsc, "HDFC0001234");
    assert.equal(r.value.payee.accountNumber, "50100012345678");
    assert.equal(r.value.payee.name, "ABC Traders");
    assert.equal(r.value.amount, 12500.5);
    assert.equal(r.value.debitAccount, DEBIT);
  });

  it("rejects symbols in the payee name and remarks", () => {
    const r = validate({ payeeName: "ABC & Sons", remarks: "Inv#1" });
    assert.ok(r.errors.payeeName);
    assert.ok(r.errors.remarks);
  });

  it("limits NEFT remarks to 32 characters but not other modes", () => {
    const long = "A".repeat(40);
    assert.ok(validate({ remarks: long }).errors.remarks);
    assert.equal(validate({ remarks: long, txnType: "IFS" }).ok, true);
  });

  it("enforces the RTGS minimum and IMPS maximum", () => {
    assert.ok(validate({ txnType: "RTG", amount: "199999.99" }).errors.amount);
    assert.equal(validate({ txnType: "RTG", amount: "200000" }).ok, true);
    assert.ok(validate({ txnType: "IFS", amount: "500000.01" }).errors.amount);
    assert.equal(validate({ txnType: "IFS", amount: "500000" }).ok, true);
  });

  it("rejects bad amounts", () => {
    for (const amount of ["0", "-5", "12.345", "1e5", "", "abc"]) {
      assert.ok(validate({ amount }).errors.amount, `amount ${amount}`);
    }
  });

  it("rejects a bad IFSC and an unknown mode", () => {
    assert.ok(validate({ ifsc: "HDFC1001234" }).errors.ifsc);
    assert.ok(validate({ txnType: "UPI" }).errors.txnType);
  });

  it("forces the ICICI transfer IFSC for ICICI to ICICI", () => {
    const r = validate({ txnType: "TPA", ifsc: "" });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.value.payee.ifsc, ICICI_FT_IFSC);
  });

  it("refuses to pay into the debit account itself", () => {
    assert.ok(validate({ accountNumber: DEBIT }).errors.accountNumber);
  });

  it("needs a configured debit account", () => {
    const r = validatePayoutInput(base, { debitAccount: "" });
    assert.ok(r.errors.debitAccount);
  });
});

describe("mapBankResult", () => {
  it("submission held for net-banking approval", () => {
    const r = mapBankResult({ RESPONSE: "SUCCESS", STATUS: "Pending For approval", REQID: "123" });
    assert.equal(r.status, "AWAITING_BANK_APPROVAL");
    assert.equal(r.reqId, "123");
  });

  it("success without a status but with a submitted message waits for approval", () => {
    const r = mapBankResult({ RESPONSE: "SUCCESS", MESSAGE: "Transaction submitted successfully" });
    assert.equal(r.status, "AWAITING_BANK_APPROVAL");
  });

  it("paid with UTR", () => {
    const r = mapBankResult({ RESPONSE: "SUCCESS", STATUS: "SUCCESS", UTRNUMBER: "ICICR123" });
    assert.equal(r.status, "SUCCESS");
    assert.equal(r.utr, "ICICR123");
  });

  it("pending and processing states", () => {
    assert.equal(mapBankResult({ STATUS: "PENDING" }).status, "PROCESSING");
    assert.equal(mapBankResult({ STATUS: "Processing" }).status, "PROCESSING");
  });

  it("failures and reversals", () => {
    assert.equal(mapBankResult({ RESPONSE: "SUCCESS", STATUS: "FAILURE" }).status, "FAILED");
    assert.equal(mapBankResult({ RESPONSE: "FAILURE", MESSAGE: "Invalid IFSC" }).status, "FAILED");
    assert.equal(mapBankResult({ STATUS: "REVERSED" }).status, "REVERSED");
  });

  it("retry-later codes are unknown, never failed", () => {
    for (const code of ["8010", "8012", "8013", "103068"]) {
      assert.equal(mapBankResult({ RESPONSE: "FAILURE", ERRORCODE: code }).status, "UNKNOWN", code);
    }
    assert.equal(
      mapBankResult({ RESPONSE: "FAILURE", MESSAGE: "8010 - Please check status after some time" }).status,
      "UNKNOWN"
    );
    assert.equal(mapBankResult({ STATUS: "DUPLICATE" }).status, "UNKNOWN");
    assert.equal(mapBankResult({}).status, "UNKNOWN");
  });
});

describe("generatePayoutUniqueId", () => {
  it("is 15 characters, starts with RB and the date", () => {
    const id = generatePayoutUniqueId(new Date(2026, 9, 9));
    assert.equal(id.length, 15);
    assert.match(id, /^RB261009[0-9A-Z]{7}$/);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generatePayoutUniqueId()));
    assert.equal(ids.size, 2000);
  });
});

describe("validateBeneficiaryInput", () => {
  const payee = {
    name: "ABC Traders",
    accountNumber: "50100012345678",
    confirmAccountNumber: "50100012345678",
    ifsc: "HDFC0001234",
    type: "VENDOR",
  };
  const check = (patch = {}) => validateBeneficiaryInput({ ...payee, ...patch }, { debitAccount: DEBIT });

  it("registers a non-ICICI payee", () => {
    const r = check();
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.value.bankKind, "NON_ICICI");
  });

  it("registers an ICICI payee from its ICIC IFSC", () => {
    const r = check({ ifsc: "icic0000104", bankKind: "ICICI" });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.value.bankKind, "ICICI");
    assert.equal(r.value.bankName, "ICICI Bank");
    assert.equal(bankKindOf("ICIC0000011"), "ICICI");
  });

  it("rejects a bank choice that contradicts the IFSC", () => {
    assert.ok(check({ bankKind: "ICICI" }).errors.ifsc);
    assert.ok(check({ ifsc: "ICIC0000104", bankKind: "NON_ICICI" }).errors.ifsc);
  });

  it("rejects invalid payees", () => {
    const r = check({
      name: "A&B",
      accountNumber: "12-34",
      confirmAccountNumber: "12-34",
      ifsc: "HDFC123",
      mobile: "12345",
    });
    assert.deepEqual(Object.keys(r.errors).sort(), ["accountNumber", "ifsc", "mobile", "name"]);
  });

  it("needs the account number typed twice to match", () => {
    assert.ok(check({ confirmAccountNumber: "50100012345679" }).errors.confirmAccountNumber);
  });

  it("refuses our own debit account", () => {
    assert.ok(check({ accountNumber: DEBIT, confirmAccountNumber: DEBIT }).errors.accountNumber);
  });

  it("accepts a +91 mobile number", () => {
    assert.equal(check({ mobile: "+91 98765 43210" }).value.mobile, "9876543210");
  });
});

describe("Excel row parsing", () => {
  it("reads payment modes the way people write them", () => {
    assert.equal(normaliseMode("neft"), "RGS");
    assert.equal(normaliseMode("RTGS"), "RTG");
    assert.equal(normaliseMode(" imps "), "IFS");
    assert.equal(normaliseMode("ICICI to ICICI"), "TPA");
    assert.equal(normaliseMode("UPI"), "UPI");
  });

  it("maps a payment row, cleaning the amount and labels", () => {
    const input = payoutRowToInput({
      name: "ABC Traders",
      accountNumber: 50100012345678,
      ifsc: "hdfc0001234",
      mode: "NEFT",
      amount: "₹1,25,000.50",
      purpose: "Vendor bill",
      payeeType: "farmer",
    });
    assert.equal(input.payeeName, "ABC Traders");
    assert.equal(input.accountNumber, "50100012345678");
    assert.equal(input.txnType, "RGS");
    assert.equal(input.amount, "125000.50");
    assert.equal(input.purpose, "VENDOR_BILL");
    assert.equal(input.payeeType, "FARMER");
  });

  it("maps a payee row and its bank", () => {
    assert.equal(beneficiaryRowToInput({ bank: "ICICI Bank" }).bankKind, "ICICI");
    assert.equal(beneficiaryRowToInput({ bank: "Other" }).bankKind, "NON_ICICI");
    assert.equal(beneficiaryRowToInput({}).bankKind, "");
    assert.equal(beneficiaryRowToInput({ payeeName: "X", type: "dealer" }).type, "DEALER");
  });
});

describe("roles and masking", () => {
  const cfg = { payout: { checkerRoles: ["SUPER_ADMIN"] } };

  it("checker role comes from role or job title", () => {
    assert.equal(isPayoutChecker({ role: "SUPER_ADMIN" }, cfg), true);
    assert.equal(isPayoutChecker({ role: "EMPLOYEE", jobTitle: "SUPER_ADMIN" }, cfg), true);
    assert.equal(isPayoutChecker({ role: "ACCOUNTANT" }, cfg), false);
    assert.equal(isPayoutChecker(null, cfg), false);
  });

  it("masks all but the last four digits", () => {
    assert.equal(maskAccount("50100012345678"), "••••••5678");
    assert.equal(maskAccount("1234"), "1234");
  });
});
