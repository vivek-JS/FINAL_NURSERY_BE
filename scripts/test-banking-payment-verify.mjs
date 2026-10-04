/**
 * End-to-end test of per-payment bank verification, run against STAGE.
 *
 * Order 3462 only exists in production, so the script copies that document into
 * the stage database, exercises every branch of checkPaymentAgainstBank against
 * it with dummy payments and dummy statement lines, then deletes everything it
 * created — including the finance shadow rows the verification triggers.
 *
 * Usage: node scripts/test-banking-payment-verify.mjs [orderId]
 */
import "dotenv/config";
import crypto from "crypto";
import mongoose from "mongoose";

const ORDER_ID = Number(process.argv[2] || 3462);
const ACCOUNT = "000405001234";

/** Everything written during the run, removed in cleanup(). */
const created = {
  orders: [],
  bankstatemententries: [],
  suspenseentries: [],
  cashbooks: [],
  paymentreconciliations: [],
  bankreconciliationmatches: [],
  financialevents: [],
  financevouchers: [],
  journalentries: [],
  ledgerlines: [],
};

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const oid = () => new mongoose.Types.ObjectId();

async function fetchProdOrder() {
  const prod = await mongoose.createConnection(process.env.PROD_MONGO_URL).asPromise();
  const doc = await prod.collection("orders").findOne({ orderId: ORDER_ID });
  await prod.close();
  if (!doc) throw new Error(`Order ${ORDER_ID} not found in production`);
  return doc;
}

/** Add a PENDING payment to the stage order and return its id. */
async function addPayment(Order, orderMongoId, { amount, utr, date, cheque }) {
  const order = await Order.findById(orderMongoId);
  order.payment.push({
    paidAmount: amount,
    paymentDate: date,
    paymentStatus: "PENDING",
    modeOfPayment: cheque ? "Cheque" : "NEFT/RTGS",
    bankName: "ICICI",
    ...(utr ? { utrNumber: utr, transactionId: utr } : {}),
    ...(cheque ? { chequeNumber: cheque } : {}),
    remark: "DUMMY — banking verification test",
  });
  await order.save();
  return String(order.payment[order.payment.length - 1]._id);
}

async function addStatementLine(BankStatementEntry, over = {}) {
  const line = {
    accountNumber: ACCOUNT,
    txnDate: new Date(),
    amount: 500,
    txnType: "CREDIT",
    narration: "DUMMY NEFT CR-BANKING TEST",
    reconciliationStatus: "UNMATCHED",
    source: "MANUAL",
    ...over,
  };
  const entry = await BankStatementEntry.create({
    ...line,
    entryHash: crypto
      .createHash("sha256")
      .update(
        [line.txnDate.toISOString(), line.amount, line.referenceNumber ?? "", line.narration, oid()].join("|")
      )
      .digest("hex"),
  });
  created.bankstatemententries.push(entry._id);
  return entry;
}

async function paymentSubdoc(Order, orderMongoId, paymentId) {
  const order = await Order.findById(orderMongoId).lean();
  return (order.payment || []).find((p) => String(p._id) === String(paymentId));
}

async function run() {
  const prodOrder = await fetchProdOrder();
  console.log(`Cloning production order ${ORDER_ID} (${prodOrder._id}) into stage\n`);

  await mongoose.connect(process.env.STAGE_MONGO_URL);
  console.log("stage db:", mongoose.connection.name, "\n");

  const existing = await mongoose.connection.collection("orders").findOne({ _id: prodOrder._id });
  if (existing) throw new Error("Clone already present in stage — refusing to overwrite");
  await mongoose.connection.collection("orders").insertOne(prodOrder);
  created.orders.push(prodOrder._id);

  const orderMongoId = String(prodOrder._id);

  const { default: Order } = await import("../models/order.model.js");
  await import("../models/farmer.model.js"); // loadPayment populates the farmer ref
  const { default: BankStatementEntry } = await import("../models/bankStatementEntry.model.js");
  const { default: SuspenseEntry } = await import("../modules/banking/models/suspenseEntry.model.js");
  const { default: CashBook } = await import("../modules/banking/models/cashBook.model.js");
  const { checkPaymentAgainstBank } = await import(
    "../modules/banking/services/paymentBankCheck.service.js"
  );
  const { markStatementVerified } = await import(
    "../modules/banking/services/bankStatement.service.js"
  );
  const { createCashDeposit, listCashDeposits, verifyCashDeposit } = await import(
    "../modules/banking/services/cashDeposit.service.js"
  );
  const { linkSuspenseToPayment } = await import(
    "../modules/banking/services/suspense.service.js"
  );

  const verify = (paymentId, opts = {}) =>
    checkPaymentAgainstBank({
      source: "order",
      orderMongoId,
      paymentId,
      allowLiveLookup: false,
      ...opts,
    });

  // ---- Scenario A: exact UTR and amount -----------------------------------
  console.log("A. Exact UTR and amount");
  const utrA = "ICICTEST00000001";
  const dateA = new Date();
  const payA = await addPayment(Order, orderMongoId, { amount: 2500, utr: utrA, date: dateA });
  const lineA = await addStatementLine(BankStatementEntry, {
    amount: 2500,
    txnDate: dateA,
    referenceNumber: utrA,
  });

  const resA = await verify(payA);
  check("returns VERIFIED", resA.result === "VERIFIED", resA.message);
  check("matched on UTR and date", resA.matchedBy === "UTR_AMOUNT_DATE", `rule=${resA.matchedBy}`);
  check("confidence is 98", resA.score === 98, `score=${resA.score}`);

  const subA = await paymentSubdoc(Order, orderMongoId, payA);
  check("paymentStatus is BANK_VERIFIED", subA.paymentStatus === "BANK_VERIFIED");
  check("bankVerificationStatus is BANK_VERIFIED", subA.bankVerificationStatus === "BANK_VERIFIED");
  check("source recorded as STATEMENT_API", subA.bankVerificationSource === "STATEMENT_API");
  check(
    "matchedBy collapsed to the schema enum",
    subA.bankVerificationMatchedBy === "UTR",
    `stored=${subA.bankVerificationMatchedBy}`
  );
  check("bank amount copied onto payment", subA.bankAmount === 2500, `₹${subA.bankAmount}`);
  check("bank reference copied onto payment", subA.bankReferenceNumber === utrA);

  const lineAafter = await BankStatementEntry.findById(lineA._id).lean();
  check("statement line marked MATCHED", lineAafter.reconciliationStatus === "MATCHED");
  check("line points back at the payment", String(lineAafter.matchedPaymentId) === payA);

  const cashA = await CashBook.find({ paymentId: payA }).lean();
  cashA.forEach((c) => created.cashbooks.push(c._id));
  check("one cash book row posted", cashA.length === 1, `${cashA.length} row(s)`);

  // ---- Scenario B: verifying twice is idempotent ---------------------------
  console.log("\nB. Verifying the same payment again");
  const resB = await verify(payA);
  check("still reports VERIFIED", resB.result === "VERIFIED");
  check("flagged as already verified", resB.alreadyVerified === true);

  const cashB = await CashBook.find({ paymentId: payA }).lean();
  check("no second cash book row", cashB.length === 1, `${cashB.length} row(s)`);

  // ---- Scenario C: same UTR, different amount ------------------------------
  console.log("\nC. Same UTR in the bank, different amount on the payment");
  const utrC = "ICICTEST00000003";
  const dateC = new Date();
  const payC = await addPayment(Order, orderMongoId, { amount: 7000, utr: utrC, date: dateC });
  await addStatementLine(BankStatementEntry, {
    amount: 6500,
    txnDate: dateC,
    referenceNumber: utrC,
  });

  const resC = await verify(payC);
  check("returns AMOUNT_MISMATCH", resC.result === "AMOUNT_MISMATCH", resC.message);
  check("reports the bank's amount", resC.bankAmount === 6500, `₹${resC.bankAmount}`);

  const subC = await paymentSubdoc(Order, orderMongoId, payC);
  check("payment left PENDING", subC.paymentStatus === "PENDING");

  const suspC = await SuspenseEntry.find({ paymentId: payC }).lean();
  suspC.forEach((s) => created.suspenseentries.push(s._id));
  check("suspense row opened", suspC.length === 1 && suspC[0].reason === "AMOUNT_MISMATCH",
    suspC.map((s) => s.reason).join(",") || "none");

  // ---- Scenario D: two equally good candidates -----------------------------
  // The UTR is present (so the check runs) but absent from both lines, so each
  // falls back to the amount-and-date rule and they tie.
  console.log("\nD. Two bank credits that match equally well");
  const dateD = new Date();
  const payD = await addPayment(Order, orderMongoId, {
    amount: 3300,
    date: dateD,
    utr: "ICICTEST00000004",
  });
  await addStatementLine(BankStatementEntry, { amount: 3300, txnDate: dateD, referenceNumber: "" });
  await addStatementLine(BankStatementEntry, { amount: 3300, txnDate: dateD, referenceNumber: "" });

  const resD = await verify(payD);
  check(
    "returns MULTIPLE_MATCH",
    resD.result === "MULTIPLE_MATCH",
    resD.message || resD.error || JSON.stringify(resD)
  );

  const subD = await paymentSubdoc(Order, orderMongoId, payD);
  check("payment left PENDING", subD.paymentStatus === "PENDING");

  const suspD = await SuspenseEntry.find({ paymentId: payD }).lean();
  suspD.forEach((s) => created.suspenseentries.push(s._id));
  check("suspense row opened", suspD.length >= 1, suspD.map((s) => s.reason).join(","));

  // ---- Scenario E: a verified statement line is retired --------------------
  console.log("\nE. A statement line already marked verified is never reused");
  const utrE = "ICICTEST00000005";
  const dateE = new Date();
  const lineE = await addStatementLine(BankStatementEntry, {
    amount: 1800,
    txnDate: dateE,
    referenceNumber: utrE,
  });
  const marked = await markStatementVerified(String(lineE._id), { userId: null });
  check("line marked verified", marked.ok === true && marked.entry.statementVerified === true);

  const payE = await addPayment(Order, orderMongoId, { amount: 1800, utr: utrE, date: dateE });
  const resE = await verify(payE);
  check("returns NOT_FOUND despite a perfect line", resE.result === "NOT_FOUND", resE.message);

  const subE = await paymentSubdoc(Order, orderMongoId, payE);
  check("payment left PENDING", subE.paymentStatus === "PENDING");

  // ---- Scenario F: no reference at all -------------------------------------
  console.log("\nF. Payment with no UTR, txn id or cheque");
  const payF = await addPayment(Order, orderMongoId, { amount: 900, date: new Date(), utr: "" });
  const resF = await verify(payF);
  check("refuses with a clear error", resF.ok === false, resF.error);

  // ---- Scenario G: cash deposit entry validation ---------------------------
  console.log("\nG. Cash deposit entry");
  const badAmount = await createCashDeposit({
    entryDate: new Date(),
    amount: 0,
    accountNumber: ACCOUNT,
  });
  check("rejects a zero amount", badAmount.ok === false, badAmount.error);

  const badAccount = await createCashDeposit({ entryDate: new Date(), amount: 5000 });
  check("rejects a missing bank account", badAccount.ok === false, badAccount.error);

  const badDate = await createCashDeposit({ amount: 5000, accountNumber: ACCOUNT });
  check("rejects a missing date", badDate.ok === false, badDate.error);

  const dateG = new Date();
  const depG = await createCashDeposit({
    entryDate: dateG,
    amount: 15000,
    accountNumber: ACCOUNT,
    slipNumber: "SLIP-TEST-001",
    narration: "DUMMY counter deposit",
  });
  check("records a valid deposit", depG.ok === true, depG.error);
  if (depG.ok) created.cashbooks.push(depG.deposit._id);
  check("stored as CASH_IN", depG.deposit?.entryType === "CASH_IN");
  check("starts unverified", depG.deposit?.depositVerified === false);
  check("slip number retained", depG.deposit?.slipNumber === "SLIP-TEST-001");

  const listed = await listCashDeposits({ accountNumber: ACCOUNT, verified: false });
  check(
    "appears in the unverified list",
    listed.some((d) => String(d._id) === String(depG.deposit._id)),
    `${listed.length} unverified deposit(s)`
  );

  // ---- Scenario H: verify before the bank has posted the credit -----------
  console.log("\nH. Verifying a deposit the bank has not posted yet");
  const resH = await verifyCashDeposit(String(depG.deposit._id), { userId: null });
  check("reports no match rather than failing", resH.ok === true && resH.matched === false, resH.message);
  const depH = await CashBook.findById(depG.deposit._id).lean();
  check("deposit left unverified", depH.depositVerified === false);

  // ---- Scenario I: the bank posts the credit ------------------------------
  console.log("\nI. The bank posts the matching credit");
  const wrongAccountLine = await addStatementLine(BankStatementEntry, {
    amount: 15000,
    txnDate: dateG,
    accountNumber: "999999999999",
    narration: "DUMMY CASH DEP OTHER ACCOUNT",
  });
  const resIa = await verifyCashDeposit(String(depG.deposit._id), { userId: null });
  check("a credit on another account is ignored", resIa.matched === false, resIa.message);

  const lineI = await addStatementLine(BankStatementEntry, {
    amount: 15000,
    txnDate: new Date(dateG.getTime() + 24 * 60 * 60 * 1000), // next day, inside the window
    narration: "DUMMY CASH DEP SLIP-TEST-001",
  });
  const resI = await verifyCashDeposit(String(depG.deposit._id), { userId: null });
  check("matches the credit", resI.ok === true && resI.matched === true, resI.message);

  const depI = await CashBook.findById(depG.deposit._id).lean();
  check("deposit marked verified", depI.depositVerified === true);
  check("verifiedAt stamped", Boolean(depI.depositVerifiedAt));
  check("linked to the bank line", String(depI.verifiedAgainstEntryId) === String(lineI._id));

  const lineIafter = await BankStatementEntry.findById(lineI._id).lean();
  check("matched line retired from further matching", lineIafter.statementVerified === true);

  // ---- Scenario J: verifying the deposit twice ----------------------------
  console.log("\nJ. Verifying the same deposit again");
  const resJ = await verifyCashDeposit(String(depG.deposit._id), { userId: null });
  check("reports already verified", resJ.ok === true && resJ.alreadyVerified === true);

  const stillOne = await CashBook.countDocuments({ slipNumber: "SLIP-TEST-001" });
  check("no duplicate deposit row", stillOne === 1, `${stillOne} row(s)`);

  // ---- Scenario K: the retired deposit line is not reused by UTR matching --
  console.log("\nK. The deposit's line cannot also settle a payment");
  const payK = await addPayment(Order, orderMongoId, {
    amount: 15000,
    utr: "ICICTEST00000006",
    date: dateG,
  });
  const resK = await verify(payK);
  check("payment is not verified", resK.result !== "VERIFIED", resK.message);

  const subK = await paymentSubdoc(Order, orderMongoId, payK);
  check("payment left PENDING", subK.paymentStatus === "PENDING");

  const lineKcheck = await BankStatementEntry.findById(lineI._id).lean();
  check("retired credit still retired", lineKcheck.statementVerified === true);
  check(
    "retired credit not claimed by the payment",
    String(lineKcheck.matchedPaymentId || "") !== payK,
    `matchedPaymentId=${lineKcheck.matchedPaymentId}`
  );
  // The 65-point candidate it did find is the other-account line from scenario I:
  // cross-account credits are offered as fuzzy candidates but can never auto-verify.
  check(
    "any cross-account candidate only reaches suspense",
    resK.result !== "VERIFIED" && (resK.score ?? 0) < 85,
    `score=${resK.score ?? "none"}`
  );

  // ---- Scenario L: linking a suspense row to a payment --------------------
  console.log("\nL. Resolving a suspense row by linking it to a payment");
  const suspOpen = await SuspenseEntry.findOne({ paymentId: payD, status: "OPEN" }).lean();
  const resL = await linkSuspenseToPayment(String(suspOpen._id), {
    source: "order",
    orderMongoId,
    paymentId: payD,
    resolutionNotes: "DUMMY test link",
    userId: null,
  });
  check("link succeeds", resL.ok === true, resL.error);

  const subL = await paymentSubdoc(Order, orderMongoId, payD);
  check("payment now BANK_VERIFIED", subL.paymentStatus === "BANK_VERIFIED");
  check("recorded as a manual verification", subL.bankVerificationSource === "MANUAL");
  check("matchedBy is a legal enum value", subL.bankVerificationMatchedBy === "AMOUNT_DATE",
    `stored=${subL.bankVerificationMatchedBy}`);

  const suspL = await SuspenseEntry.findById(suspOpen._id).lean();
  check("suspense row closed", suspL.status === "RESOLVED", `status=${suspL.status}`);

  // ---- Scenario N: only UTR + amount may clear a payment ------------------
  console.log("\nN. Cheque and transaction-id matches must not clear by themselves");

  const dateN = new Date();
  const payChq = await addPayment(Order, orderMongoId, {
    amount: 4400,
    date: dateN,
    cheque: "004412",
  });
  await addStatementLine(BankStatementEntry, {
    amount: 4400,
    txnDate: dateN,
    referenceNumber: "",
    chequeNumber: "004412",
  });
  const resChq = await verify(payChq);
  check("cheque match goes to suspense", resChq.result === "NEEDS_REVIEW", resChq.message);
  check("explains it was not a UTR", /cheque number, not a UTR/.test(resChq.message || ""));

  const subChq = await paymentSubdoc(Order, orderMongoId, payChq);
  check("cheque payment left PENDING", subChq.paymentStatus === "PENDING");

  const suspChq = await SuspenseEntry.find({ paymentId: payChq }).lean();
  check("suspense row carries the score", suspChq[0]?.confidenceScore === 85,
    `score=${suspChq[0]?.confidenceScore}`);

  const dateN2 = new Date();
  const payTxn = await addPayment(Order, orderMongoId, { amount: 4600, date: dateN2, utr: "" });
  await mongoose.connection.collection("orders").updateOne(
    { _id: prodOrder._id, "payment._id": new mongoose.Types.ObjectId(payTxn) },
    { $set: { "payment.$.transactionId": "BANKTXN99", "payment.$.utrNumber": "" } }
  );
  await addStatementLine(BankStatementEntry, {
    amount: 4600,
    txnDate: dateN2,
    referenceNumber: "",
    transactionId: "BANKTXN99",
  });
  const resTxn = await verify(payTxn);
  check("transaction-id match goes to suspense", resTxn.result === "NEEDS_REVIEW", resTxn.message);
  check("scored 90 but still not cleared", resTxn.score === 90, `score=${resTxn.score}`);

  const subTxn = await paymentSubdoc(Order, orderMongoId, payTxn);
  check("transaction-id payment left PENDING", subTxn.paymentStatus === "PENDING");

  // ---- Scenario M: live lookup with ICICI not configured ------------------
  console.log("\nM. Live ICICI lookup while credentials/certs are absent");
  const payM = await addPayment(Order, orderMongoId, {
    amount: 123.45,
    utr: "ICICTEST00000007",
    date: new Date(),
  });
  const resM = await checkPaymentAgainstBank({
    source: "order",
    orderMongoId,
    paymentId: payM,
    allowLiveLookup: true,
  });
  check("fails cleanly instead of throwing", resM.ok === false, resM.error);
  check("reported as unreachable, not NOT_FOUND", resM.code === "ICICI_UNREACHABLE", `code=${resM.code}`);

  const subM = await paymentSubdoc(Order, orderMongoId, payM);
  check("payment left PENDING", subM.paymentStatus === "PENDING");

  // collect finance rows for cleanup
  const paymentIds = [payA, payC, payD, payE, payF, payK, payM, payChq, payTxn];
  await collectFinanceRows(paymentIds);
  await collectBankingRows(paymentIds);
}

async function collectFinanceRows(paymentIds) {
  const keys = paymentIds.map((p) => `bank:verified:${p}`);
  const events = await mongoose.connection
    .collection("financialevents")
    .find({ idempotencyKey: { $in: keys } })
    .toArray();
  for (const e of events) {
    created.financialevents.push(e._id);
    if (e.voucherId) created.financevouchers.push(e.voucherId);
  }
  if (!created.financevouchers.length) return;

  const journals = await mongoose.connection
    .collection("journalentries")
    .find({ voucherId: { $in: created.financevouchers } })
    .toArray();
  journals.forEach((j) => created.journalentries.push(j._id));

  if (!created.journalentries.length) return;
  const lines = await mongoose.connection
    .collection("ledgerlines")
    .find({ journalEntryId: { $in: created.journalentries } })
    .toArray();
  lines.forEach((l) => created.ledgerlines.push(l._id));
}

async function collectBankingRows(paymentIds) {
  for (const name of [
    "paymentreconciliations",
    "bankreconciliationmatches",
    "cashbooks",
    "suspenseentries",
  ]) {
    const rows = await mongoose.connection
      .collection(name)
      .find({ paymentId: { $in: paymentIds } })
      .toArray();
    rows.forEach((r) => {
      if (!created[name].some((id) => String(id) === String(r._id))) created[name].push(r._id);
    });
  }
}

async function cleanup() {
  console.log("\nCleanup");
  for (const [name, ids] of Object.entries(created)) {
    if (!ids.length) continue;
    const { deletedCount } = await mongoose.connection
      .collection(name)
      .deleteMany({ _id: { $in: ids } });
    console.log(`  ${name}: removed ${deletedCount}/${ids.length}`);
  }

  const leftoverOrder = await mongoose.connection
    .collection("orders")
    .findOne({ orderId: ORDER_ID });
  console.log(`  stage order ${ORDER_ID} present after cleanup: ${Boolean(leftoverOrder)}`);
}

let failed = false;
try {
  await run();
} catch (err) {
  failed = true;
  console.error("\nRUN ERROR:", err.message);
  console.error(err.stack);
} finally {
  try {
    if (mongoose.connection.readyState === 1) await cleanup();
  } catch (e) {
    console.error("CLEANUP ERROR:", e.message);
  }
  await mongoose.disconnect();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (failed || passed !== results.length) {
  console.log("Failures:");
  results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name} ${r.detail}`));
  process.exit(1);
}
