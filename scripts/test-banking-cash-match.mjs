/**
 * End-to-end test of matching cash payments and cash deposits against the bank
 * statement, against a throwaway local database that is dropped at the end.
 *
 * Usage: node scripts/test-banking-cash-match.mjs
 *        BANKING_TEST_MONGO_URL=mongodb://127.0.0.1:27017 node scripts/...
 */
import crypto from "crypto";
import mongoose from "mongoose";

const BASE = process.env.BANKING_TEST_MONGO_URL || "mongodb://127.0.0.1:27017";
const DB_NAME = `banking_cash_match_test_${Date.now()}`;
const ACCOUNT = "000405001234";
const DAY = 24 * 60 * 60 * 1000;
const PHOTO = "https://res.cloudinary.com/demo/image/upload/slip.jpg";

const daysAgo = (n, hour = 12) => {
  const d = new Date(Date.now() - n * DAY);
  d.setHours(hour, 0, 0, 0);
  return d;
};
const ymd = (d) => d.toISOString().slice(0, 10);

process.env.BANKING_CASHBOOK_START_DATE = ymd(daysAgo(30));
process.env.ICICI_CORPORATE_USE_HTTP = "false";
process.env.ICICI_CORPORATE_USE_STUB = "true";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

await mongoose.connect(`${BASE}/${DB_NAME}`);

const { default: AgriSalesOrder } = await import("../models/agriSalesOrder.model.js");
const { default: User } = await import("../models/user.model.js");
const { default: BankStatementEntry } = await import("../models/bankStatementEntry.model.js");
const { default: SuspenseEntry } = await import("../modules/banking/models/suspenseEntry.model.js");
const { runEnhancedReconciliation, scoreMatch } = await import(
  "../modules/banking/services/reconciliationEngine.service.js"
);
const { linkSuspenseToPayment, resolveSuspense } = await import(
  "../modules/banking/services/suspense.service.js"
);
const { cashInHandOf } = await import("../modules/banking/services/cashInHand.service.js");
const { createCashDeposit } = await import("../modules/banking/services/cashDeposit.service.js");
const { default: CashBook } = await import("../modules/banking/models/cashBook.model.js");
const { runBankCheck } = await import("../modules/banking/services/bankAutoCheck.service.js");
const { isCashCreditLine } = await import("../modules/banking/utils/cashNarration.js");

const E = new mongoose.Types.ObjectId();
const ACCOUNTANT = new mongoose.Types.ObjectId();

async function agriOrder(payments) {
  return AgriSalesOrder.create({
    orderNumber: `T-${crypto.randomUUID().slice(0, 8)}`,
    customerName: "Test Customer",
    customerMobile: "9999999999",
    productId: new mongoose.Types.ObjectId(),
    productName: "Test product",
    quantity: 1,
    unit: "pieces",
    rate: 100000,
    totalAmount: 100000,
    createdBy: E,
    payment: payments.map((p) => ({
      paymentDate: daysAgo(1),
      modeOfPayment: "Cash",
      paymentStatus: "PENDING",
      ...p,
    })),
  });
}

const line = (amount, narration, when = daysAgo(1, 15)) =>
  BankStatementEntry.create({
    accountNumber: ACCOUNT,
    txnDate: when,
    amount,
    narration,
    source: "IMPORT",
    entryHash: crypto.randomUUID(),
  });

const run = () => runEnhancedReconciliation(daysAgo(10), new Date(), { source: "all", userId: ACCOUNTANT });
const paymentOf = async (order) => (await AgriSalesOrder.findById(order._id).lean()).payment[0];
const openRow = (paymentId, extra = {}) =>
  SuspenseEntry.findOne({ paymentId: String(paymentId), status: "OPEN", ...extra }).lean();

try {
  console.log(`\nDatabase ${DB_NAME}\n`);
  await User.collection.insertOne({ _id: E, name: "Esha Sales", phoneNumber: 9000000011, jobTitle: "SALES" });

  check("narration: BY CASH is a cash line", isCashCreditLine({ amount: 10, narration: "BY CASH DEP BR 123" }));
  check("narration: UPI is not a cash line", !isCashCreditLine({ amount: 10, narration: "UPI/123/RAMESH" }));

  const direct = await agriOrder([{ paidAmount: 2500 }]);
  const held = await agriOrder([{ paidAmount: 3300 }]);
  const twice = await agriOrder([{ paidAmount: 7100 }]);
  const forDeposit = await agriOrder([{ paidAmount: 6000, paymentStatus: "COLLECTED" }]);
  const upi = await agriOrder([{ paidAmount: 4100, modeOfPayment: "UPI", utrNumber: "UPI998877" }]);

  const lDirect = await line(2500, "BY CASH DEPOSIT BR 0004");
  const lNear = await line(7100, "CASH DEP 0004");
  const lFar = await line(7100, "BY CASH 0004", daysAgo(0, 9));
  const lDeposit = await line(6000, "BY CASH DEPOSIT SELF");
  const lUpiLookalike = await line(4100, "CASH DEPOSIT BR 0004");

  check(
    "UPI payment never fuzzy-matches a cash line",
    !scoreMatch({ paidAmount: 4100, paymentDate: daysAgo(1), utrNumber: "UPI998877", modeOfPayment: "UPI" }, lUpiLookalike.toObject())
  );

  const expectedStart = 2500 + 3300 + 7100 + 6000;
  check("employee starts with all cash in hand", (await cashInHandOf(E)) === expectedStart, String(await cashInHandOf(E)));

  const dep = await createCashDeposit({
    entryDate: ymd(daysAgo(1)),
    accountNumber: ACCOUNT,
    slipNumber: "S-9",
    amount: 6000,
    employeeId: E,
    slipPhotos: [PHOTO],
    userId: ACCOUNTANT,
  });
  check("deposit recorded", dep.ok, dep.error);

  const r1 = await run();
  check("run reports one deposit matched", r1.depositsMatched === 1, String(r1.depositsMatched));
  const depAfter = await CashBook.findById(dep.deposit._id).lean();
  check("deposit verified against its bank line", depAfter.depositVerified && String(depAfter.bankTransactionId) === String(lDeposit._id));

  const pDirect = await paymentOf(direct);
  const rowDirect = await openRow(pDirect._id);
  check("cash paid into the bank gives a CASH_MATCH row", rowDirect?.reason === "CASH_MATCH", rowDirect?.reason);
  check("CASH_MATCH row points at the cash line", String(rowDirect?.bankTransactionId) === String(lDirect._id));
  check("CASH_MATCH payment is not auto-verified", pDirect.paymentStatus === "PENDING");

  const pHeld = await paymentOf(held);
  check("cash with no bank line has no suspense row", !(await openRow(pHeld._id)));
  check("run counts cash still in hand", r1.waiting?.cashInHand >= 1, JSON.stringify(r1.waiting));
  check("run counts cash matches", r1.cashMatches === 2, String(r1.cashMatches));

  const pUpi = await paymentOf(upi);
  const upiOnCash = await SuspenseEntry.findOne({ paymentId: String(pUpi._id), bankTransactionId: lUpiLookalike._id }).lean();
  check("UPI payment is not paired with a cash line", !upiOnCash);

  const pTwice = await paymentOf(twice);
  const rowNear = await openRow(pTwice._id);
  check("nearest cash line offered first", String(rowNear?.bankTransactionId) === String(lNear._id));

  const r2 = await run();
  const rows = await SuspenseEntry.countDocuments({ paymentId: String(pDirect._id), status: "OPEN" });
  check("rerun does not duplicate rows", rows === 1 && r2.cashMatches === 0, `${rows} / ${r2.cashMatches}`);

  const link = await linkSuspenseToPayment(rowDirect._id, {
    source: "agriSales",
    orderMongoId: String(direct._id),
    paymentId: String(pDirect._id),
    userId: ACCOUNTANT,
  });
  check("Confirm links the payment", link.ok, link.error);
  const pDirectAfter = await paymentOf(direct);
  check("confirmed cash payment is bank verified", pDirectAfter.bankVerificationStatus === "BANK_VERIFIED");
  check(
    "confirmed cash leaves the employee's cash in hand",
    (await cashInHandOf(E)) === expectedStart - 6000 - 2500,
    String(await cashInHandOf(E))
  );

  const dismiss = await resolveSuspense(rowNear._id, { action: "RESOLVE", userId: ACCOUNTANT, resolutionNotes: "Not this" });
  check("Not this closes the row", dismiss.ok, dismiss.error);
  await run();
  const again = await SuspenseEntry.findOne({
    paymentId: String(pTwice._id),
    bankTransactionId: lNear._id,
    status: "OPEN",
  }).lean();
  check("dismissed pairing is not offered again", !again);
  const next = await openRow(pTwice._id);
  check("the other cash line is offered instead", String(next?.bankTransactionId) === String(lFar._id), String(next?.bankTransactionId));

  const auto = await runBankCheck({ from: daysAgo(2), reason: "test" });
  check("auto check runs without a live bank", auto.fetch?.fetched === false && Array.isArray(auto.suspense));
} catch (err) {
  console.error(err);
  check("no exception", false, err.message);
} finally {
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
