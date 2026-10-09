/**
 * End-to-end test of maker-checker payouts against the stub bank and a
 * throwaway local database that is dropped at the end.
 *
 * Covers: create, self-approval blocked, non-approver blocked, approve →
 * held for ICICI approval, status refresh → paid with UTR, reject, cancel,
 * duplicate warning, bank failure, resend after no answer, listing/summary.
 *
 * Usage: node scripts/test-banking-payouts.mjs
 *        BANKING_TEST_MONGO_URL=mongodb://127.0.0.1:27017 node scripts/...
 */
import mongoose from "mongoose";

process.env.ICICI_CORPORATE_USE_STUB = "true";
process.env.ICICI_PAYOUT_CHECKER_ROLES = "SUPER_ADMIN";

const BASE = process.env.BANKING_TEST_MONGO_URL || "mongodb://127.0.0.1:27017";
const DB_NAME = `banking_payouts_test_${Date.now()}`;

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function expectError(name, code, fn) {
  try {
    await fn();
    check(name, false, "no error");
  } catch (err) {
    check(name, err.code === code, `${err.code}: ${err.message}`);
  }
}

await mongoose.connect(`${BASE}/${DB_NAME}`);

const svc = await import("../modules/banking/services/iciciPayout.service.js");
const { default: IciciPayout } = await import("../modules/banking/models/iciciPayout.model.js");

const maker = { _id: new mongoose.Types.ObjectId(), name: "Asha Accountant", role: "ACCOUNTANT" };
const checker = { _id: new mongoose.Types.ObjectId(), name: "Ravi Admin", role: "SUPER_ADMIN" };
const adminMaker = { _id: new mongoose.Types.ObjectId(), name: "Mina Admin", role: "SUPER_ADMIN" };

const input = (patch = {}) => ({
  txnType: "RGS",
  payeeName: "ABC Traders",
  accountNumber: "50100012345678",
  ifsc: "HDFC0001234",
  amount: "12500.50",
  remarks: "Invoice 4471",
  purpose: "VENDOR_BILL",
  payeeType: "VENDOR",
  referenceNo: "BILL-4471",
  ...patch,
});

try {
  console.log("Happy path");
  const p = await svc.createPayout(input(), maker);
  check("created awaiting ERP approval", p.status === "PENDING_APPROVAL" && p.uniqueId.length === 15);

  await expectError("maker without approver role cannot approve", "FORBIDDEN", () =>
    svc.approvePayout(p._id, maker)
  );

  const own = await svc.createPayout(input({ accountNumber: "60100012345678" }), adminMaker);
  await expectError("approver cannot approve their own payment", "SELF_APPROVAL", () =>
    svc.approvePayout(own._id, adminMaker)
  );

  const approved = await svc.approvePayout(p._id, checker, { note: "Checked bill" });
  check(
    "approval sends to ICICI and waits for net-banking approval",
    approved.status === "AWAITING_BANK_APPROVAL" && approved.checkerName === "Ravi Admin" && !!approved.bank?.reqId,
    approved.status
  );
  await expectError("cannot approve twice", "BAD_STATE", () => svc.approvePayout(p._id, checker));

  const actions = approved.history.map((h) => h.action).join(",");
  check("history records create, approve, send", actions === "CREATED,APPROVED,SENT_TO_BANK", actions);

  const summaryMid = await svc.payoutSummary();
  check("summary counts payment awaiting ICICI", summaryMid.awaitingBankApproval.count === 1);

  const refreshed = await svc.refreshPayoutStatus(p._id, checker);
  check(
    "status refresh marks it paid with UTR",
    refreshed.checked && refreshed.payout.status === "SUCCESS" && /^STUBUTR/.test(refreshed.payout.bank.utr || ""),
    refreshed.payout.status
  );
  const again = await svc.refreshPayoutStatus(p._id, checker);
  check("paid payment is not checked again", again.checked === false && again.payout.status === "SUCCESS");

  console.log("Reject and cancel");
  await expectError("reject needs a reason", "VALIDATION", () => svc.rejectPayout(own._id, checker, {}));
  await expectError("maker without approver role cannot reject", "FORBIDDEN", () =>
    svc.rejectPayout(own._id, maker, { reason: "x" })
  );
  const rejected = await svc.rejectPayout(own._id, checker, { reason: "Wrong account" });
  check("rejected with reason", rejected.status === "REJECTED" && rejected.rejectReason === "Wrong account");

  const c = await svc.createPayout(input({ accountNumber: "70100012345678" }), maker);
  await expectError("someone else cannot cancel the maker's payment", "FORBIDDEN", () =>
    svc.cancelPayout(c._id, { _id: new mongoose.Types.ObjectId(), role: "ACCOUNTANT" })
  );
  const cancelled = await svc.cancelPayout(c._id, maker, { reason: "Paid by cheque" });
  check("maker can cancel before approval", cancelled.status === "CANCELLED");
  await expectError("cancelled payment cannot be approved", "BAD_STATE", () =>
    svc.approvePayout(c._id, checker)
  );

  console.log("Duplicates and validation");
  await expectError("same account and amount within 7 days warns", "POSSIBLE_DUPLICATE", () =>
    svc.createPayout(input(), maker)
  );
  const dup = await svc.createPayout(input(), maker, { confirmDuplicate: true });
  check("duplicate can be created when confirmed", dup.status === "PENDING_APPROVAL");
  await expectError("invalid input is rejected", "VALIDATION", () =>
    svc.createPayout(input({ ifsc: "BAD", amount: "0" }), maker)
  );

  console.log("Bank failure and no answer");
  const f = await svc.createPayout(input({ accountNumber: "80100012345678", remarks: "STUBFAIL" }), maker);
  await svc.approvePayout(f._id, checker);
  const failed = await svc.refreshPayoutStatus(f._id);
  check("bank failure is recorded", failed.payout.status === "FAILED" && !!failed.payout.bank.completedAt);

  const u = await svc.createPayout(input({ accountNumber: "90100012345678" }), maker);
  await svc.approvePayout(u._id, checker);
  await IciciPayout.updateOne({ _id: u._id }, { $set: { status: "UNKNOWN" } });
  await expectError("maker cannot resend", "FORBIDDEN", () => svc.resendPayout(u._id, maker));
  const resent = await svc.resendPayout(u._id, checker);
  check(
    "resend keeps the same reference",
    resent.status === "AWAITING_BANK_APPROVAL" && resent.uniqueId === u.uniqueId,
    resent.status
  );
  await expectError("only unknown payments can be resent", "BAD_STATE", () => svc.resendPayout(u._id, checker));

  console.log("Stale submission and poller");
  const s = await svc.createPayout(input({ accountNumber: "11100012345678" }), maker);
  await IciciPayout.updateOne(
    { _id: s._id },
    { $set: { status: "SUBMITTING", updatedAt: new Date(Date.now() - 10 * 60 * 1000) } },
    { timestamps: false }
  );
  await svc.pollOpenPayouts({ gapMs: 0 });
  const stale = await IciciPayout.findById(s._id).lean();
  const staleSteps = stale.history.map((h) => `${h.fromStatus || ""}>${h.toStatus}`).join(",");
  check(
    "stuck submission becomes 'no bank answer', then the poller asks ICICI",
    staleSteps.includes("SUBMITTING>UNKNOWN") && stale.status === "SUCCESS",
    staleSteps
  );
  const recent = await IciciPayout.findById(u._id).lean();
  check("poller skips a payment checked moments ago", recent.status === "AWAITING_BANK_APPROVAL", recent.status);

  console.log("Payee register (UAT: beneficiary scenarios)");
  const bene = await import("../modules/banking/services/iciciBeneficiary.service.js");
  const icici = await bene.createBeneficiary(
    { name: "Ram Seeds", accountNumber: "000401234567", ifsc: "ICIC0000004", bankKind: "ICICI", type: "VENDOR" },
    maker
  );
  check("register ICICI payee", icici.status === "PENDING_APPROVAL" && icici.bankKind === "ICICI");
  const other = await bene.createBeneficiary(
    { name: "Kisan Agro", accountNumber: "33330012345678", ifsc: "SBIN0001234", type: "FARMER" },
    maker
  );
  check("register non-ICICI payee", other.bankKind === "NON_ICICI");

  await expectError("duplicate payee is refused", "DUPLICATE_BENEFICIARY", () =>
    bene.createBeneficiary({ name: "Kisan Agro Again", accountNumber: "33330012345678", ifsc: "sbin0001234" }, maker)
  );
  await expectError("invalid payee is refused", "VALIDATION", () =>
    bene.createBeneficiary({ name: "Bad & Co", accountNumber: "12", ifsc: "XX" }, maker)
  );
  await expectError("unapproved payee cannot be paid", "VALIDATION", () =>
    svc.createPayout(input({ beneficiaryId: other._id, amount: "500" }), maker)
  );
  await expectError("maker cannot approve their own payee", "FORBIDDEN", () =>
    bene.approveBeneficiary(other._id, maker)
  );
  const ownBene = await bene.createBeneficiary(
    { name: "Mina Supplier", accountNumber: "44440012345678", ifsc: "HDFC0004444" },
    adminMaker
  );
  await expectError("approver cannot approve a payee they added", "SELF_APPROVAL", () =>
    bene.approveBeneficiary(ownBene._id, adminMaker)
  );

  const activeOther = await bene.approveBeneficiary(other._id, checker);
  const activeIcici = await bene.approveBeneficiary(icici._id, checker);
  check("approved payees are active (validation success)", activeOther.status === "ACTIVE" && activeIcici.status === "ACTIVE");

  const viaBene = await svc.createPayout(
    { beneficiaryId: other._id, txnType: "IFS", amount: "750", purpose: "FARMER_REFUND", payeeName: "Tampered" },
    maker
  );
  check(
    "payout to an approved payee uses the register's details",
    viaBene.payee.name === "Kisan Agro" && viaBene.payee.accountNumber === "33330012345678" && String(viaBene.beneficiaryId) === String(other._id)
  );
  await expectError("ICICI to ICICI is refused for a non-ICICI payee", "VALIDATION", () =>
    svc.createPayout({ beneficiaryId: other._id, txnType: "TPA", amount: "800" }, maker)
  );
  const tpa = await svc.createPayout({ beneficiaryId: icici._id, txnType: "TPA", amount: "900" }, maker);
  check("ICICI payee paid ICICI to ICICI with the transfer IFSC", tpa.payee.ifsc === "ICIC0000011");

  await bene.disableBeneficiary(other._id, checker, { reason: "Account closed" });
  await expectError("payment to a payee disabled later cannot be approved", "BAD_STATE", () =>
    svc.approvePayout(viaBene._id, checker)
  );
  await svc.rejectPayout(viaBene._id, checker, { reason: "Payee disabled" });
  const readded = await bene.createBeneficiary(
    { name: "Kisan Agro", accountNumber: "33330012345678", ifsc: "SBIN0001234" },
    maker
  );
  check("disabled payee can be registered again", readded.status === "PENDING_APPROVAL");
  await bene.rejectBeneficiary(ownBene._id, checker, { reason: "No KYC" });
  await svc.cancelPayout(tpa._id, maker);

  process.env.ICICI_PAYOUT_REQUIRE_BENEFICIARY = "true";
  await expectError("one-time payees refused when the register is required", "VALIDATION", () =>
    svc.createPayout(input({ accountNumber: "55550012345678" }), maker)
  );
  delete process.env.ICICI_PAYOUT_REQUIRE_BENEFICIARY;

  const listed = await bene.listBeneficiaries({ status: "ACTIVE" });
  check("register lists only active payees", listed.total === 1 && listed.items[0].name === "Ram Seeds", `total ${listed.total}`);

  console.log("Lists");
  const approval = await svc.listPayouts({ view: "approval" });
  check("approval view lists only payments awaiting approval", approval.items.every((x) => x.status === "PENDING_APPROVAL") && approval.total === 1, `total ${approval.total}`);
  const done = await svc.listPayouts({ view: "done" });
  check("completed view has 2 paid, failed, 2 rejected and 2 cancelled", done.total === 7, `total ${done.total}`);
  const found = await svc.listPayouts({ search: "BILL-4471" });
  check("search by bill number", found.total >= 1);
  const summary = await svc.payoutSummary();
  check(
    "summary: paid today and failed in 30 days",
    summary.paidToday.count === 2 && summary.paidToday.amount === 25001 && summary.failed30d.count === 1,
    JSON.stringify({ paid: summary.paidToday, failed: summary.failed30d })
  );
} catch (err) {
  console.error(err);
  check("script ran without crashing", false, err.message);
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
