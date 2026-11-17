/**
 * End-to-end test of Registration Status, De-registration and NEFT Incremental
 * Status against the stub bank and a throwaway local MongoDB (dropped at the end).
 *
 *   node scripts/test-banking-cib-status.mjs
 *   BANKING_TEST_MONGO_URL=mongodb://127.0.0.1:27017 node scripts/test-banking-cib-status.mjs
 */
import mongoose from "mongoose";

process.env.ICICI_CORPORATE_USE_STUB = "true";
process.env.ICICI_PAYOUT_CHECKER_ROLES = "SUPER_ADMIN";

const BASE = process.env.BANKING_TEST_MONGO_URL || "mongodb://127.0.0.1:27017";
const DB_NAME = `banking_cib_status_test_${Date.now()}`;

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

await mongoose.connect(`${BASE}/${DB_NAME}`);

const reg = await import("../modules/banking/services/iciciRegistration.service.js");
const neft = await import("../modules/banking/services/iciciNeftStatus.service.js");
const payouts = await import("../modules/banking/services/iciciPayout.service.js");
const { default: IciciRegistration } = await import("../modules/banking/models/iciciRegistration.model.js");
const { default: IciciPayout } = await import("../modules/banking/models/iciciPayout.model.js");

const maker = { _id: new mongoose.Types.ObjectId(), name: "Asha Accountant", role: "ACCOUNTANT" };
const checker = { _id: new mongoose.Types.ObjectId(), name: "Ravi Admin", role: "SUPER_ADMIN" };

async function paidNeft(patch = {}) {
  const p = await payouts.createPayout(
    {
      txnType: "RGS",
      payeeName: "ABC Traders",
      accountNumber: `5010001${Math.floor(Math.random() * 1e7)}`,
      ifsc: "HDFC0001234",
      amount: String(1000 + Math.floor(Math.random() * 9000)),
      remarks: "Invoice 4471",
      purpose: "VENDOR_BILL",
      payeeType: "VENDOR",
      ...patch,
    },
    maker,
    { confirmDuplicate: true }
  );
  await payouts.approvePayout(p._id, checker);
  await payouts.refreshPayoutStatus(p._id);
  return IciciPayout.findById(p._id);
}

try {
  console.log("Registration Status Inquiry");
  await reg.registerWithIcici({ userId: checker._id });
  const status = await reg.fetchRegistrationStatus({ userId: checker._id });
  check("status is REGISTERED", status.state === "REGISTERED", status.bankStatus);
  const active = await IciciRegistration.findOne({ status: "ACTIVE" }).lean();
  check("bank status saved on the registration", active?.bankStatus === "Registered" && !!active.bankStatusCheckedAt);

  console.log("CIB De-registration");
  const dereg = await reg.deregisterFromIcici({ userId: checker._id });
  check("de-registration accepted", dereg.ok === true && dereg.state === "DEREGISTERED");
  const revoked = await IciciRegistration.findOne({}).lean();
  check("registration revoked", revoked.status === "REVOKED" && !!revoked.deregisteredAt);
  check("no active registration left", (await reg.getLatestRegistration()) === null);

  console.log("NEFT Incremental Status");
  const byUtr = await neft.fetchNeftIncrementalStatus({ utr: "057262551" });
  check("lookup by UTR answers CREDITED", byUtr.state === "CREDITED", byUtr.status);
  try {
    await neft.fetchNeftIncrementalStatus({ utr: "" });
    check("blank UTR rejected", false, "no error");
  } catch (e) {
    check("blank UTR rejected", e.code === "VALIDATION", e.message);
  }

  const credited = await paidNeft();
  check("NEFT payout reached SUCCESS with UTR", credited.status === "SUCCESS" && !!credited.bank.utr, credited.bank.utr);

  const returned = await paidNeft();
  returned.bank.utr = "STUBREFUND0001";
  await returned.save();

  const imps = await paidNeft({ txnType: "IFS" });

  const run1 = await neft.trackNeftPayouts({ gapMs: 0 });
  check("tracker checks only the NEFT payouts", run1.checked === 2, JSON.stringify(run1));
  check("tracker reverses the returned one", run1.reversed === 1);

  const c = await IciciPayout.findById(credited._id).lean();
  check("credited NEFT stays SUCCESS", c.status === "SUCCESS" && c.bank.neft.state === "CREDITED");
  const r = await IciciPayout.findById(returned._id).lean();
  check(
    "returned NEFT becomes REVERSED with reason",
    r.status === "REVERSED" && r.bank.neft.state === "REFUNDED" && /ACCOUNT CLOSED/.test(r.bank.message),
    r.bank.message
  );
  check("reversal is in the history", r.history.at(-1)?.toStatus === "REVERSED");
  const i = await IciciPayout.findById(imps._id).lean();
  check("IMPS payout untouched", !i.bank?.neft?.state);

  const run2 = await neft.trackNeftPayouts({ gapMs: 0 });
  check("final NEFT states are not asked again", run2.checked === 0, JSON.stringify(run2));

  console.log("Beneficiary Registration (approve → ICICI /BeneAddition)");
  const benes = await import("../modules/banking/services/iciciBeneficiary.service.js");
  const beneReg = await import("../modules/banking/services/iciciBeneRegistration.service.js");
  const draft = await benes.createBeneficiary(
    { name: "Citi Vendor", accountNumber: "010506009999", confirmAccountNumber: "010506009999", ifsc: "CITI0000003" },
    maker
  );
  check("payee waits for ERP approval, not sent to ICICI yet", draft.status === "PENDING_APPROVAL" && !draft.bank?.state);
  check("create validates the account at ICICI", draft.bank?.validationState === "VALIDATED", draft.bank?.validationState);

  const beneVal = await import("../modules/banking/services/iciciBeneValidation.service.js");
  const liveVal = await beneVal.validateBeneficiaryAtIcici({ accountNumber: "000451000301", ifsc: "ICIC0000011", name: "Citi Vendor" });
  check("on-demand validation SUCCESS", liveVal.state === "VALIDATED", liveVal.message);
  const badAcc = await beneVal.validateBeneficiaryAtIcici({ accountNumber: "000000000000" });
  check("invalid beneficiary account", badAcc.state === "INVALID_ACCOUNT", badAcc.message);
  const storedVal = await beneVal.validateBeneficiaryAtBank(draft._id, checker);
  check("stored validation on the payee", storedVal.validated === true && storedVal.payee.history.some((h) => h.action === "BANK_VALIDATED"));
  const approvedBene = await benes.approveBeneficiary(draft._id, checker);
  check(
    "approval registers the payee at ICICI",
    approvedBene.status === "ACTIVE" && approvedBene.bank?.state === "REGISTERED" && approvedBene.bank.coolingPeriod === true,
    approvedBene.bank?.message
  );
  check("approval recorded in history", approvedBene.history.some((h) => h.action === "BANK_REGISTERED"));
  const again = await beneReg.registerBeneficiaryAtBank(draft._id, checker);
  check("re-registering an already registered payee does not call ICICI again", again.already === true && again.payee.bank.attempts === 1);

  process.env.ICICI_BENE_REGISTER_ON_APPROVE = "false";
  const draft2 = await benes.createBeneficiary(
    { name: "Axis Vendor", accountNumber: "020506009999", ifsc: "UTIB0000400" },
    maker
  );
  const erpOnly = await benes.approveBeneficiary(draft2._id, checker);
  check("ICICI_BENE_REGISTER_ON_APPROVE=false keeps it ERP-only", erpOnly.status === "ACTIVE" && !erpOnly.bank?.state);
  delete process.env.ICICI_BENE_REGISTER_ON_APPROVE;
  const later = await beneReg.registerBeneficiaryAtBank(draft2._id, checker);
  check("manual register-bank sends it later", later.registered === true && later.payee.bank.state === "REGISTERED");
  try {
    await beneReg.registerBeneficiaryAtBank(draft._id.toString().replace(/.$/, "0"), checker);
    check("unknown payee rejected", false, "no error");
  } catch (e) {
    check("unknown payee rejected", e.code === "NOT_FOUND", e.message);
  }

  const manual = await neft.refreshPayoutNeft(credited._id, checker);
  check("manual check on one payout", manual.checked === true && manual.neft.state === "CREDITED");
  const notNeft = await neft.refreshPayoutNeft(imps._id, checker);
  check("manual check refuses a non-NEFT payout", notNeft.checked === false, notNeft.warning);
} catch (err) {
  check("unexpected error", false, err.stack);
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
