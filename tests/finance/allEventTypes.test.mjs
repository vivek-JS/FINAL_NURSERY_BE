import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildJournalLines } from "../../modules/finance/events/buildJournalLines.js";
import { FINANCIAL_EVENT_TYPES, ACCOUNT_CODES } from "../../modules/finance/domain/constants.js";

function assertBalanced(lines, label) {
  assert.ok(lines?.length >= 2, `${label}: expected at least 2 lines`);
  let dr = 0;
  let cr = 0;
  for (const l of lines) {
    dr += l.debit || 0;
    cr += l.credit || 0;
    assert.ok(!(l.debit > 0 && l.credit > 0), `${label}: line has both dr and cr`);
  }
  assert.equal(dr, cr, `${label}: not balanced dr=${dr} cr=${cr}`);
  assert.ok(dr > 0, `${label}: zero total`);
}

function sumAccount(lines, code) {
  let dr = 0;
  let cr = 0;
  for (const l of lines) {
    if (l.accountCode !== code) continue;
    dr += l.debit || 0;
    cr += l.credit || 0;
  }
  return { dr, cr, net: dr - cr };
}

describe("buildJournalLines — all financial event types", () => {
  const amount = 5000;
  const mobile = "9876543210";
  const dealerId = "507f1f77bcf86cd799439011";

  it("FARMER_ORDER_CREATED", () => {
    const lines = buildJournalLines(FINANCIAL_EVENT_TYPES.FARMER_ORDER_CREATED, {
      amount,
      customerMobile: mobile,
      partyId: mobile,
    });
    assertBalanced(lines, "farmer order");
    const ar = sumAccount(lines, ACCOUNT_CODES.AR_FARMER);
    assert.equal(ar.net, amount);
  });

  it("FARMER_PAYMENT_COLLECTED (cash)", () => {
    const lines = buildJournalLines(FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_COLLECTED, {
      amount,
      customerMobile: mobile,
      modeOfPayment: "Cash",
    });
    assertBalanced(lines, "farmer payment cash");
    assert.ok(sumAccount(lines, ACCOUNT_CODES.CASH).dr > 0);
    assert.ok(sumAccount(lines, ACCOUNT_CODES.AR_FARMER).cr > 0);
  });

  it("FARMER_PAYMENT_COLLECTED (UPI → clearing)", () => {
    const lines = buildJournalLines(FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_COLLECTED, {
      amount,
      customerMobile: mobile,
      modeOfPayment: "UPI",
    });
    assertBalanced(lines, "farmer payment upi");
    assert.ok(sumAccount(lines, ACCOUNT_CODES.PAYMENT_CLEARING).dr > 0);
  });

  it("FARMER_PAYMENT_REVERSED", () => {
    const lines = buildJournalLines(FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_REVERSED, {
      amount,
      customerMobile: mobile,
      modeOfPayment: "Cash",
    });
    assertBalanced(lines, "farmer reversal");
    assert.ok(sumAccount(lines, ACCOUNT_CODES.AR_FARMER).dr > 0);
  });

  it("FARMER_ORDER_DELTA increase", () => {
    const lines = buildJournalLines(FINANCIAL_EVENT_TYPES.FARMER_ORDER_DELTA, {
      amount: 200,
      isIncrease: true,
      customerMobile: mobile,
    });
    assertBalanced(lines, "farmer delta +");
  });

  it("FARMER_ORDER_DELTA decrease", () => {
    const lines = buildJournalLines(FINANCIAL_EVENT_TYPES.FARMER_ORDER_DELTA, {
      amount: 200,
      isIncrease: false,
      customerMobile: mobile,
    });
    assertBalanced(lines, "farmer delta -");
  });

  it("FARMER_ORDER_CANCEL", () => {
    const lines = buildJournalLines(FINANCIAL_EVENT_TYPES.FARMER_ORDER_CANCEL, {
      amount,
      customerMobile: mobile,
    });
    assertBalanced(lines, "farmer cancel");
    assert.ok(sumAccount(lines, ACCOUNT_CODES.AR_FARMER).cr > 0);
  });

  it("FARMER_ORDER_REOPEN", () => {
    const lines = buildJournalLines(FINANCIAL_EVENT_TYPES.FARMER_ORDER_REOPEN, {
      amount,
      customerMobile: mobile,
    });
    assertBalanced(lines, "farmer reopen");
  });

  it("FARMER_DISPATCH_RETURN", () => {
    const lines = buildJournalLines(FINANCIAL_EVENT_TYPES.FARMER_DISPATCH_RETURN, {
      amount: 300,
      customerMobile: mobile,
    });
    assertBalanced(lines, "dispatch return");
    assert.ok(sumAccount(lines, ACCOUNT_CODES.SALES_RETURN).dr > 0);
  });

  it("FARMER_ADVANCE_TRANSFER OUT and IN", () => {
    const out = buildJournalLines(FINANCIAL_EVENT_TYPES.FARMER_ADVANCE_TRANSFER, {
      amount: 1000,
      direction: "OUT",
      customerMobile: mobile,
    });
    const inn = buildJournalLines(FINANCIAL_EVENT_TYPES.FARMER_ADVANCE_TRANSFER, {
      amount: 1000,
      direction: "IN",
      customerMobile: mobile,
    });
    assertBalanced(out, "advance out");
    assertBalanced(inn, "advance in");
  });

  it("FARMER_PAYMENT_TRANSFER REVERSAL and CREDIT", () => {
    const rev = buildJournalLines(FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_TRANSFER, {
      amount: 1000,
      direction: "REVERSAL",
      customerMobile: mobile,
    });
    const cred = buildJournalLines(FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_TRANSFER, {
      amount: 1000,
      direction: "CREDIT",
      customerMobile: mobile,
    });
    assertBalanced(rev, "xfer reversal");
    assertBalanced(cred, "xfer credit");
  });

  it("FARMER_MANUAL_ADJUSTMENT debit and credit", () => {
    const dr = buildJournalLines(FINANCIAL_EVENT_TYPES.FARMER_MANUAL_ADJUSTMENT, {
      amount: 50,
      isDebit: true,
      customerMobile: mobile,
    });
    const cr = buildJournalLines(FINANCIAL_EVENT_TYPES.FARMER_MANUAL_ADJUSTMENT, {
      amount: 50,
      isDebit: false,
      customerMobile: mobile,
    });
    assertBalanced(dr, "manual dr");
    assertBalanced(cr, "manual cr");
  });

  it("AGRI_ORDER_CREATED", () => {
    const lines = buildJournalLines(FINANCIAL_EVENT_TYPES.AGRI_ORDER_CREATED, {
      amount,
      customerMobile: mobile,
    });
    assertBalanced(lines, "agri order");
    assert.ok(sumAccount(lines, ACCOUNT_CODES.AR_AGRI).net > 0);
  });

  it("AGRI_PAYMENT_COLLECTED and REVERSED", () => {
    const c = buildJournalLines(FINANCIAL_EVENT_TYPES.AGRI_PAYMENT_COLLECTED, {
      amount,
      customerMobile: mobile,
      modeOfPayment: "Cash",
    });
    const r = buildJournalLines(FINANCIAL_EVENT_TYPES.AGRI_PAYMENT_REVERSED, {
      amount,
      customerMobile: mobile,
      modeOfPayment: "Cash",
    });
    assertBalanced(c, "agri collected");
    assertBalanced(r, "agri reversed");
  });

  it("AGRI_ORDER_DELTA and SALES_RETURN", () => {
    const d = buildJournalLines(FINANCIAL_EVENT_TYPES.AGRI_ORDER_DELTA, {
      amount: 100,
      isIncrease: true,
      customerMobile: mobile,
    });
    const ret = buildJournalLines(FINANCIAL_EVENT_TYPES.AGRI_SALES_RETURN, {
      amount: 200,
      customerMobile: mobile,
      refundPayout: false,
    });
    const refund = buildJournalLines(FINANCIAL_EVENT_TYPES.AGRI_SALES_RETURN, {
      amount: 200,
      customerMobile: mobile,
      refundPayout: true,
    });
    assertBalanced(d, "agri delta");
    assertBalanced(ret, "agri return credit");
    assertBalanced(refund, "agri refund payout");
    assert.ok(sumAccount(refund, ACCOUNT_CODES.BANK_ICICI).cr > 0);
  });

  it("AGRI_MANUAL_ADJUSTMENT", () => {
    const lines = buildJournalLines(FINANCIAL_EVENT_TYPES.AGRI_MANUAL_ADJUSTMENT, {
      amount: 75,
      isDebit: true,
      customerMobile: mobile,
    });
    assertBalanced(lines, "agri manual");
  });

  it("DEALER_ORDER_BOOKING and RECEIVABLE_PAYMENT", () => {
    const b = buildJournalLines(FINANCIAL_EVENT_TYPES.DEALER_ORDER_BOOKING, {
      amount,
      dealerId,
    });
    const p = buildJournalLines(FINANCIAL_EVENT_TYPES.DEALER_RECEIVABLE_PAYMENT, {
      amount,
      dealerId,
    });
    assertBalanced(b, "dealer booking");
    assertBalanced(p, "dealer recv pay");
  });

  it("DEALER_ORDER_CANCEL and REOPEN", () => {
    const cancel = buildJournalLines(FINANCIAL_EVENT_TYPES.DEALER_ORDER_CANCEL, {
      amount,
      dealerId,
    });
    const reopen = buildJournalLines(FINANCIAL_EVENT_TYPES.DEALER_ORDER_REOPEN, {
      amount,
      dealerId,
    });
    assertBalanced(cancel, "dealer cancel");
    assertBalanced(reopen, "dealer reopen");
  });

  it("DEALER_WALLET_MOVEMENT credit and debit", () => {
    const pay = buildJournalLines(FINANCIAL_EVENT_TYPES.DEALER_WALLET_MOVEMENT, {
      amount: 1000,
      dealerId,
      walletCredit: true,
      farmerPartyId: mobile,
    });
    const topup = buildJournalLines(FINANCIAL_EVENT_TYPES.DEALER_WALLET_MOVEMENT, {
      amount: 500,
      dealerId,
      walletCredit: false,
    });
    assertBalanced(pay, "wallet pay");
    assertBalanced(topup, "wallet topup");
  });

  it("DEALER_COMMISSION_SETTLEMENT", () => {
    const lines = buildJournalLines(FINANCIAL_EVENT_TYPES.DEALER_COMMISSION_SETTLEMENT, {
      amount: 800,
      dealerId,
    });
    assertBalanced(lines, "commission");
    assert.ok(sumAccount(lines, ACCOUNT_CODES.COMMISSION_EXPENSE).dr > 0);
  });

  it("BANK_PAYMENT_VERIFIED and BANK_STATEMENT_UNMATCHED", () => {
    const v = buildJournalLines(FINANCIAL_EVENT_TYPES.BANK_PAYMENT_VERIFIED, {
      amount: 2500,
    });
    const cr = buildJournalLines(FINANCIAL_EVENT_TYPES.BANK_STATEMENT_UNMATCHED, {
      amount: 2500,
      isCredit: true,
    });
    const dr = buildJournalLines(FINANCIAL_EVENT_TYPES.BANK_STATEMENT_UNMATCHED, {
      amount: 1000,
      isCredit: false,
    });
    assertBalanced(v, "bank verified");
    assertBalanced(cr, "bank suspense credit");
    assertBalanced(dr, "bank suspense debit");
  });

  it("returns null for zero amount", () => {
    const lines = buildJournalLines(FINANCIAL_EVENT_TYPES.FARMER_ORDER_CREATED, {
      amount: 0,
      customerMobile: mobile,
    });
    assert.equal(lines, null);
  });
});
