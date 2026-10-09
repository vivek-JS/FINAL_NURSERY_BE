/**
 * End-to-end test of the suspense lifecycle in runEnhancedReconciliation,
 * against a throwaway local database that is dropped at the end.
 *
 * Covers: NO_MATCH after the grace period, a suspense payment clearing itself
 * when its line arrives later, AMOUNT_MISMATCH in the batch run, one row per
 * bank line, a credit just outside the run's range, write-off and
 * return-to-pending sticking across runs.
 *
 * Usage: node scripts/test-banking-suspense-lifecycle.mjs
 *        BANKING_TEST_MONGO_URL=mongodb://127.0.0.1:27017 node scripts/...
 */
import crypto from "crypto";
import mongoose from "mongoose";

process.env.ICICI_CORPORATE_USE_STUB = "true";

const BASE = process.env.BANKING_TEST_MONGO_URL || "mongodb://127.0.0.1:27017";
const DB_NAME = `banking_suspense_test_${Date.now()}`;
const ACCOUNT = "000405001234";
const DAY = 24 * 60 * 60 * 1000;

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const daysAgo = (n) => {
  const d = new Date(Date.now() - n * DAY);
  d.setHours(12, 0, 0, 0);
  return d;
};

await mongoose.connect(`${BASE}/${DB_NAME}`);

const { default: AgriSalesOrder } = await import("../models/agriSalesOrder.model.js");
const { default: BankStatementEntry } = await import("../models/bankStatementEntry.model.js");
const { default: SuspenseEntry } = await import("../modules/banking/models/suspenseEntry.model.js");
const { runEnhancedReconciliation } = await import(
  "../modules/banking/services/reconciliationEngine.service.js"
);
const { resolveSuspense } = await import("../modules/banking/services/suspense.service.js");

async function makeOrder(payment) {
  const order = await AgriSalesOrder.create({
    orderNumber: `T-${crypto.randomUUID().slice(0, 8)}`,
    customerName: "Test Customer",
    customerMobile: "9999999999",
    productId: new mongoose.Types.ObjectId(),
    productName: "Test product",
    quantity: 1,
    unit: "pieces",
    rate: payment.paidAmount,
    totalAmount: payment.paidAmount,
    createdBy: new mongoose.Types.ObjectId(),
    payment: [
      {
        modeOfPayment: "NEFT/RTGS",
        paymentStatus: "PENDING",
        bankVerificationStatus: "PENDING",
        ...payment,
      },
    ],
  });
  return { order, paymentId: String(order.payment[0]._id) };
}

async function makeLine({ amount, txnDate, ref = "", chequeNumber = "", narration = "CR" }) {
  return BankStatementEntry.create({
    accountNumber: ACCOUNT,
    txnDate,
    amount,
    referenceNumber: ref,
    utr: ref,
    chequeNumber,
    narration,
    source: "IMPORT",
    entryHash: crypto.randomUUID(),
  });
}

async function paymentOf({ order }) {
  const fresh = await AgriSalesOrder.findById(order._id).lean();
  return fresh.payment[0];
}

const openRows = (filter) => SuspenseEntry.find({ ...filter, status: { $in: ["OPEN", "IN_REVIEW"] } }).lean();

const run = (from, to) => runEnhancedReconciliation(from, to, { source: "all" });

try {
  console.log(`\nDatabase ${DB_NAME}\n`);

  // Orphan credit with no ERP payment, inside the range.
  const orphan = await makeLine({ amount: 777, txnDate: daysAgo(3), narration: "UNKNOWN CREDIT" });

  // P1: paid 10 days ago, no bank line yet.
  const p1 = await makeOrder({ paidAmount: 5000, paymentDate: daysAgo(10), utrNumber: "UTRP1000001" });
  // P2: bank shows the same UTR at a different amount.
  const p2 = await makeOrder({ paidAmount: 3000, paymentDate: daysAgo(6), utrNumber: "UTRP2000002" });
  const l2 = await makeLine({ amount: 3500, txnDate: daysAgo(6), ref: "UTRP2000002" });
  // P3: cheque match — suspense, not auto-verified.
  const p3 = await makeOrder({
    paidAmount: 1200,
    paymentDate: daysAgo(5),
    modeOfPayment: "Cheque",
    chequeNumber: "00441299",
  });
  const l3 = await makeLine({ amount: 1200, txnDate: daysAgo(4), chequeNumber: "00441299" });
  // P4: paid today, no line — still inside the grace period.
  const p4 = await makeOrder({ paidAmount: 900, paymentDate: daysAgo(0), utrNumber: "UTRP4000004" });

  console.log("Run 1");
  const r1 = await run(daysAgo(15), daysAgo(0));

  const p1Rows = await openRows({ paymentId: p1.paymentId });
  check("P1 with no bank line goes to suspense as NO_MATCH", p1Rows.length === 1 && p1Rows[0].reason === "NO_MATCH");
  check("P1 is flagged VERIFY_FAILED", (await paymentOf(p1)).bankVerificationStatus === "VERIFY_FAILED");
  check("NO_MATCH row carries the order number", p1Rows[0]?.orderId === p1.order.orderNumber);

  const p2Rows = await openRows({ paymentId: p2.paymentId });
  check("P2 same UTR different amount → AMOUNT_MISMATCH in the batch run", p2Rows.length === 1 && p2Rows[0].reason === "AMOUNT_MISMATCH");
  check("the mismatched line is not also an orphan credit", (await openRows({ bankTransactionId: l2._id })).length === 1);

  const p3Rows = await openRows({ paymentId: p3.paymentId });
  check("P3 cheque match → MANUAL_REVIEW", p3Rows.length === 1 && p3Rows[0].reason === "MANUAL_REVIEW");
  check("the cheque line has exactly one suspense row", (await openRows({ bankTransactionId: l3._id })).length === 1);

  check("P4 inside the grace period is not reported", (await openRows({ paymentId: p4.paymentId })).length === 0);
  const orphanRows = await openRows({ bankTransactionId: orphan._id });
  check("unknown credit → ORPHAN_CREDIT", orphanRows.length === 1 && orphanRows[0].reason === "ORPHAN_CREDIT");
  check("run 1 matched nothing", r1.updatedCount === 0, `updatedCount=${r1.updatedCount}`);

  console.log("\nRun 2 — P1's credit lands, nothing else changed");
  await makeLine({ amount: 5000, txnDate: daysAgo(9), ref: "UTRP1000001" });
  const r2 = await run(daysAgo(15), daysAgo(0));
  check("P1 clears from suspense on the later run", (await paymentOf(p1)).paymentStatus === "BANK_VERIFIED");
  const p1Closed = await SuspenseEntry.findOne({ paymentId: p1.paymentId }).lean();
  check("P1's NO_MATCH row closed by SYSTEM", p1Closed.status === "RESOLVED" && p1Closed.closedBy === "SYSTEM");
  const stillOpen = (await openRows({})).length;
  check("re-running does not duplicate open rows (P2, P3, orphan)", stillOpen === 3, `open=${stillOpen}`);
  check("run 2 matched one payment", r2.updatedCount === 1, `updatedCount=${r2.updatedCount}`);

  console.log("\nWrite off the orphan credit");
  await resolveSuspense(String(orphanRows[0]._id), { action: "WRITE_OFF" });
  check("written-off orphan line becomes IGNORED", (await BankStatementEntry.findById(orphan._id).lean()).reconciliationStatus === "IGNORED");

  console.log("\nReturn P2 to pending");
  await resolveSuspense(String(p2Rows[0]._id), { action: "RESOLVE" });
  const p2After = await paymentOf(p2);
  check("P2 goes back to bank verification PENDING", p2After.bankVerificationStatus === "PENDING" && !p2After.bankReconciliationConflict);
  check("P2's line is released to UNMATCHED", (await BankStatementEntry.findById(l2._id).lean()).reconciliationStatus === "UNMATCHED");

  console.log("\nRun 3 — decisions stick");
  await run(daysAgo(15), daysAgo(0));
  check("written-off orphan is not reopened", (await openRows({ bankTransactionId: orphan._id })).length === 0);
  check("P2's dismissed AMOUNT_MISMATCH is not reopened", (await openRows({ paymentId: p2.paymentId })).length === 0);
  check("P2 stays PENDING", (await paymentOf(p2)).bankVerificationStatus === "PENDING");
  check("P3 MANUAL_REVIEW row is still the only one for it", (await openRows({ paymentId: p3.paymentId })).length === 1);

  console.log("\nCredit one day after the run's range");
  const p5 = await makeOrder({ paidAmount: 4100, paymentDate: daysAgo(30), utrNumber: "UTRP5000005" });
  await makeLine({ amount: 4100, txnDate: daysAgo(29), ref: "UTRP5000005" });
  await makeLine({ amount: 10, txnDate: daysAgo(30), narration: "INTEREST" });
  await run(daysAgo(31), daysAgo(30));
  check("payment matches a credit just outside the range", (await paymentOf(p5)).paymentStatus === "BANK_VERIFIED");
} catch (err) {
  console.error(err);
  check("script ran without throwing", false, err.message);
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
