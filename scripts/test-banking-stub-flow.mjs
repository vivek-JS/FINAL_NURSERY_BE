/**
 * Stage 1 test: the whole banking flow in stub mode, no bank involved.
 *
 *   Sync statement (stub) → Reconcile all (batch engine) → BANK_VERIFIED → COLLECTED
 *
 * This is the one path the earlier per-payment test did not cover: the batch
 * reconciliation engine and the statement ingest. ICICI is replaced by the
 * module's built-in stub, so no credentials or certificates are needed.
 *
 * Safety:
 *   - runs against STAGE only
 *   - every document id in every collection is snapshotted first, and anything
 *     new is deleted afterwards
 *   - the batch engine is global, so the run aborts if any payment other than
 *     the dummy one falls inside the date window
 *
 * Usage: node scripts/test-banking-stub-flow.mjs [orderId]
 */
process.env.ICICI_CORPORATE_USE_STUB = "true";
process.env.ICICI_ACCOUNT_ID = process.env.ICICI_ACCOUNT_ID || "000405001234";

import "dotenv/config";
import mongoose from "mongoose";

const ORDER_ID = Number(process.argv[2] || 3462);
/** An isolated window so the global batch run cannot touch real stage data. */
const WINDOW_FROM = new Date("2027-03-15T00:00:00.000Z");
const WINDOW_TO = new Date("2027-03-15T23:59:59.999Z");

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** collection name → Set of _id strings that existed before the run. */
const snapshot = new Map();

async function takeSnapshot() {
  const cols = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
  let total = 0;
  for (const name of cols) {
    const ids = await mongoose.connection
      .collection(name)
      .find({}, { projection: { _id: 1 } })
      .toArray();
    snapshot.set(name, new Set(ids.map((d) => String(d._id))));
    total += ids.length;
  }
  console.log(`Snapshotted ${total} documents across ${cols.length} collections\n`);
}

async function restoreSnapshot() {
  console.log("\nCleanup — removing everything created by this run");
  let removedTotal = 0;
  const cols = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
  for (const name of cols) {
    const before = snapshot.get(name);
    const current = await mongoose.connection
      .collection(name)
      .find({}, { projection: { _id: 1 } })
      .toArray();
    const fresh = current.filter((d) => !before || !before.has(String(d._id))).map((d) => d._id);
    if (!fresh.length) continue;
    const { deletedCount } = await mongoose.connection
      .collection(name)
      .deleteMany({ _id: { $in: fresh } });
    removedTotal += deletedCount;
    console.log(`  ${name}: removed ${deletedCount}`);
  }
  if (!removedTotal) console.log("  nothing to remove");
  return removedTotal;
}

async function fetchProdOrder() {
  const prod = await mongoose.createConnection(process.env.PROD_MONGO_URL).asPromise();
  const doc = await prod.collection("orders").findOne({ orderId: ORDER_ID });
  await prod.close();
  if (!doc) throw new Error(`Order ${ORDER_ID} not found in production`);
  return doc;
}

/** Minimal req/res pair so an Express controller can be driven from a script. */
function mockReqRes(body, user) {
  let statusCode = 200;
  const res = {
    status(c) {
      statusCode = c;
      return res;
    },
    json(payload) {
      res.body = payload;
      res.statusCode = statusCode;
      return res;
    },
  };
  return [{ body, user, query: {}, params: {} }, res];
}

async function run() {
  const prodOrder = await fetchProdOrder();

  await mongoose.connect(process.env.STAGE_MONGO_URL);
  console.log("stage db:", mongoose.connection.name);
  if (/prod/i.test(mongoose.connection.name)) throw new Error("Refusing to run: not a stage db");

  await takeSnapshot();

  const { default: Order } = await import("../models/order.model.js");
  await import("../models/farmer.model.js");
  const { default: BankStatementEntry } = await import("../models/bankStatementEntry.model.js");
  const { default: CashBook } = await import("../modules/banking/models/cashBook.model.js");
  const { default: PaymentReconciliation } = await import(
    "../modules/banking/models/paymentReconciliation.model.js"
  );
  const { getIciciCorporateConfig } = await import(
    "../modules/banking/config/iciciCorporate.config.js"
  );
  const { fetchAndStoreCorporateStatement } = await import(
    "../modules/banking/services/iciciCorporateStatement.service.js"
  );
  const { runEnhancedReconciliation } = await import(
    "../modules/banking/services/reconciliationEngine.service.js"
  );
  const { fetchAccountBalance } = await import("../modules/banking/services/iciciBalance.service.js");
  const { collectPendingBankReconciliationPayments } = await import(
    "../services/reconciliation.service.js"
  );

  check("stub mode is on", getIciciCorporateConfig().useStub === true);

  // ---- Guard: the window must be empty of real stage payments -------------
  const preexisting = await collectPendingBankReconciliationPayments(WINDOW_FROM, WINDOW_TO);
  check(
    "date window holds no real stage payments",
    preexisting.length === 0,
    `${preexisting.length} found`
  );
  if (preexisting.length) throw new Error("Aborting: window is not isolated");

  // ---- Step 1: Sync statement --------------------------------------------
  console.log("\n1. Sync statement (stub replaces ICICI)");
  const sync = await fetchAndStoreCorporateStatement(WINDOW_FROM, WINDOW_TO, null);
  check("sync reports one inserted line", sync.inserted === 1, JSON.stringify(sync));

  const lines = await BankStatementEntry.find({
    txnDate: { $gte: WINDOW_FROM, $lte: WINDOW_TO },
  }).lean();
  check("exactly one statement line stored", lines.length === 1, `${lines.length} line(s)`);
  const line = lines[0];
  check("stub UTR as documented", line?.referenceNumber === "STUBUTR4096", line?.referenceNumber);
  check("stub amount is ₹1500", line?.amount === 1500, `₹${line?.amount}`);
  check("line starts UNMATCHED", line?.reconciliationStatus === "UNMATCHED");

  console.log("\n1b. Syncing the same range again (dedupe)");
  const sync2 = await fetchAndStoreCorporateStatement(WINDOW_FROM, WINDOW_TO, null);
  const linesAfter = await BankStatementEntry.countDocuments({
    txnDate: { $gte: WINDOW_FROM, $lte: WINDOW_TO },
  });
  check("no duplicate line inserted", linesAfter === 1, `${linesAfter} line(s), sync=${JSON.stringify(sync2)}`);

  // ---- Step 2: a matching payment ----------------------------------------
  console.log("\n2. Record a payment that should match it");
  await mongoose.connection.collection("orders").insertOne(prodOrder);
  const order = await Order.findById(prodOrder._id);
  order.payment.push({
    paidAmount: 1500,
    paymentDate: WINDOW_FROM,
    paymentStatus: "PENDING",
    modeOfPayment: "UPI",
    bankName: "ICICI",
    utrNumber: "STUBUTR4096",
    transactionId: "STUBUTR4096",
    remark: "DUMMY — stub flow test",
  });
  await order.save();
  const paymentId = String(order.payment[order.payment.length - 1]._id);
  check("payment recorded as PENDING", Boolean(paymentId));

  const pending = await collectPendingBankReconciliationPayments(WINDOW_FROM, WINDOW_TO);
  check("only the dummy payment is in scope", pending.length === 1, `${pending.length} payment(s)`);
  if (pending.length !== 1) throw new Error("Aborting: other payments entered the window");

  // ---- Step 3: Reconcile all ---------------------------------------------
  console.log("\n3. Reconcile all (the batch engine the cron runs)");
  const recon = await runEnhancedReconciliation(WINDOW_FROM, WINDOW_TO, { source: "all" });
  check("one payment verified", recon.updatedCount === 1, `updatedCount=${recon.updatedCount}`);
  check("no errors", (recon.errors || []).length === 0, JSON.stringify(recon.errors));
  check("nothing sent to suspense", (recon.suspense || []).length === 0, JSON.stringify(recon.suspense));

  const m = (recon.matched || [])[0];
  check("matched the dummy payment", m?.paymentId === paymentId);
  check("matched on UTR rule", String(m?.matchedBy || "").startsWith("UTR"), `rule=${m?.matchedBy}`);
  check("confidence 98", m?.confidenceScore === 98, `score=${m?.confidenceScore}`);

  const afterRecon = await Order.findById(prodOrder._id).lean();
  const sub = afterRecon.payment.find((p) => String(p._id) === paymentId);
  check("payment is BANK_VERIFIED", sub.paymentStatus === "BANK_VERIFIED");
  check("matchedBy stored as a legal enum", sub.bankVerificationMatchedBy === "UTR",
    `stored=${sub.bankVerificationMatchedBy}`);
  check("bank reference copied", sub.bankReferenceNumber === "STUBUTR4096");

  const lineAfter = await BankStatementEntry.findById(line._id).lean();
  check("statement line MATCHED", lineAfter.reconciliationStatus === "MATCHED");

  check("cash book row posted", (await CashBook.countDocuments({ paymentId })) === 1);
  check("reconciliation audit row written",
    (await PaymentReconciliation.countDocuments({ paymentId })) === 1);

  console.log("\n3b. Reconciling again changes nothing");
  const recon2 = await runEnhancedReconciliation(WINDOW_FROM, WINDOW_TO, { source: "all" });
  check("second run verifies nothing new", recon2.updatedCount === 0, `updatedCount=${recon2.updatedCount}`);
  check("still one cash book row", (await CashBook.countDocuments({ paymentId })) === 1);

  // ---- Step 4: accountant approval ---------------------------------------
  console.log("\n4. Accountant approves it to COLLECTED");
  const orderCtrl = await import("../controllers/order.controller.js");
  const updatePaymentStatus =
    orderCtrl.default?.updatePaymentStatus || orderCtrl.updatePaymentStatus;
  check("approval handler is reachable", typeof updatePaymentStatus === "function");

  if (typeof updatePaymentStatus === "function") {
    const [req, res] = mockReqRes(
      { orderId: ORDER_ID, paymentId, paymentStatus: "COLLECTED" },
      { _id: null, role: "ACCOUNTANT" }
    );
    await updatePaymentStatus(req, res, (e) => {
      if (e) throw e;
    });
    check("approval returned 200", res.statusCode === 200 || res.statusCode === undefined,
      `status=${res.statusCode} ${JSON.stringify(res.body?.message || "")}`);

    const approved = await Order.findById(prodOrder._id).lean();
    const subApproved = approved.payment.find((p) => String(p._id) === paymentId);
    check("payment is COLLECTED", subApproved.paymentStatus === "COLLECTED",
      `status=${subApproved.paymentStatus}`);
    check("bank verification preserved", subApproved.bankVerificationStatus === "BANK_VERIFIED");
  }

  // ---- Step 5: other stub endpoints --------------------------------------
  console.log("\n5. Remaining stub endpoints respond");
  const bal = await fetchAccountBalance(null);
  check("balance returns stub data", bal?.source === "STUB", `₹${bal?.availableBalance}`);
}

let crashed = false;
try {
  await run();
} catch (err) {
  crashed = true;
  console.error("\nRUN ERROR:", err.message);
  console.error(err.stack);
} finally {
  try {
    if (mongoose.connection.readyState === 1 && snapshot.size) await restoreSnapshot();
  } catch (e) {
    console.error("CLEANUP ERROR:", e.message);
  }
  await mongoose.disconnect();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (crashed || passed !== results.length) {
  results.filter((r) => !r.pass).forEach((r) => console.log(`  FAILED: ${r.name} ${r.detail}`));
  process.exit(1);
}
