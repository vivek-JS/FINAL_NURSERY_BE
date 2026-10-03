/**
 * End-to-end test of statement import, run against STAGE.
 *
 * Proves an accountant can load a statement downloaded from net banking and
 * then settle a payment against it with no bank connection configured — the
 * path the ERP depends on until ICICI credentials exist.
 *
 * Everything is written under a throwaway account number so cleanup is exact.
 *
 * Usage: node scripts/test-banking-statement-import.mjs [orderId]
 */
import "dotenv/config";
import mongoose from "mongoose";

const ORDER_ID = Number(process.argv[2] || 3462);
/** Not a real account, so nothing here can collide with live statement data. */
const ACCOUNT = "TESTIMP0001";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const created = { orders: [], financialevents: [], financevouchers: [], journalentries: [], ledgerlines: [] };

async function fetchProdOrder() {
  const prod = await mongoose.createConnection(process.env.PROD_MONGO_URL).asPromise();
  const doc = await prod.collection("orders").findOne({ orderId: ORDER_ID });
  await prod.close();
  if (!doc) throw new Error(`Order ${ORDER_ID} not found in production`);
  return doc;
}

const STATEMENT_CSV = [
  "Statement of Transactions in Account TESTIMP0001",
  "Period: 01/04/2027 to 02/04/2027",
  "",
  "Txn Date,Value Date,Description,Ref No./Cheque No.,Debit,Credit,Balance",
  "01/04/2027,01/04/2027,UPI/CR/IMPTESTUTR001/DUMMY,IMPTESTUTR001,,2500.00,52500.00",
  '01/04/2027,01/04/2027,"NEFT, inward DUMMY LTD",IMPTESTUTR002,,7500.00,60000.00',
  "01/04/2027,01/04/2027,ATM WDL DUMMY,,1000.00,,59000.00",
  "02/04/2027,02/04/2027,CASH DEPOSIT DUMMY,,,500.00,59500.00",
  "02/04/2027,02/04/2027,CASH DEPOSIT DUMMY,,,500.00,60000.00",
  "Total,,,,1000.00,11000.00,",
].join("\n");

async function run() {
  const prodOrder = await fetchProdOrder();
  await mongoose.connect(process.env.STAGE_MONGO_URL);
  console.log(`stage db: ${mongoose.connection.name}\n`);

  await import("../models/farmer.model.js");
  const { default: Order } = await import("../models/order.model.js");
  const { default: BankStatementEntry } = await import("../models/bankStatementEntry.model.js");
  const { importStatementRows } = await import("../modules/banking/services/bankStatement.service.js");
  const { checkPaymentAgainstBank } = await import("../modules/banking/services/paymentBankCheck.service.js");

  /**
   * Counting only statement lines would let the finance rows a verification
   * posts drift unnoticed, so the baseline covers the whole chain.
   */
  const WATCHED = [
    "orders",
    "bankstatemententries",
    "paymentreconciliations",
    "bankreconciliationmatches",
    "suspenseentries",
    "cashbooks",
    "financialevents",
    "financevouchers",
    "journalentries",
    "ledgerlines",
  ];
  const snapshot = async () => {
    const out = {};
    for (const c of WATCHED) out[c] = await mongoose.connection.db.collection(c).countDocuments();
    return out;
  };

  const before = await snapshot();
  let stageOrder = null;
  let paymentId = null;

  /** Runs even when an assertion throws, so a failed run never litters stage. */
  async function cleanup() {
    console.log("\nF. cleanup");
    // The finance shadow ledger is emitted fire-and-forget, so give it a moment
    // to land before deleting — otherwise it writes its row after cleanup runs.
    await new Promise((r) => setTimeout(r, 1500));

    const db = mongoose.connection.db;
    const ids = [paymentId, stageOrder ? String(stageOrder._id) : null].filter(Boolean);
    if (paymentId) {
      // A verification posts a whole chain — event, voucher, journal, ledger
      // lines — and only the event carries the payment id. Walk the chain by
      // its foreign keys, deepest first, or the ledger rows are orphaned.
      const voucherIds = (
        await db.collection("financevouchers").find({ sourceDomain: "BankReconciliation" }).toArray()
      ).map((v) => v._id);
      const journalIds = (
        await db.collection("journalentries").find({ voucherId: { $in: voucherIds } }).toArray()
      ).map((j) => j._id);

      for (const [name, filter] of [
        ["ledgerlines", { journalEntryId: { $in: journalIds } }],
        ["journalentries", { _id: { $in: journalIds } }],
        ["financevouchers", { _id: { $in: voucherIds } }],
        ["financialevents", { idempotencyKey: `bank:verified:${paymentId}` }],
      ]) {
        const r = await db.collection(name).deleteMany(filter);
        if (r.deletedCount) console.log(`  removed ${r.deletedCount} from ${name}`);
      }
    }
    for (const c of [
      "financialevents",
      "financevouchers",
      "journalentries",
      "ledgerlines",
      "paymentreconciliations",
      "bankreconciliationmatches",
      "suspenseentries",
      "cashbooks",
    ]) {
      const res = await db.collection(c).deleteMany({
        $or: [{ paymentId: { $in: ids } }, { orderId: { $in: ids } }, { referenceId: { $in: ids } }, { accountNumber: ACCOUNT }],
      });
      if (res.deletedCount) console.log(`  removed ${res.deletedCount} from ${c}`);
    }
    const delLines = await BankStatementEntry.deleteMany({ accountNumber: ACCOUNT });
    const delOrders = await Order.deleteMany({ _id: { $in: created.orders } });
    console.log(`  removed ${delLines.deletedCount} statement lines, ${delOrders.deletedCount} orders`);

    const after = await snapshot();
    const drift = WATCHED.filter((c) => after[c] !== before[c]).map(
      (c) => `${c} ${before[c]}->${after[c]}`
    );
    check("stage is back to baseline across every collection", drift.length === 0, drift.join(", "));
    const leftover = await BankStatementEntry.countDocuments({ accountNumber: ACCOUNT });
    check("no test account rows remain", leftover === 0, `leftover=${leftover}`);
  }

  try {
  console.log("A. importing a statement export");
  const first = await importStatementRows({ csv: STATEMENT_CSV, accountNumber: ACCOUNT });
  check("import succeeds", first.ok === true, first.error || "");
  check("reads all five transactions, ignoring preamble and totals", first.total === 5, `total=${first.total}`);
  check("inserts every line", first.inserted === 5, `inserted=${first.inserted}`);
  check("counts four credits and one debit", first.credits === 4, `credits=${first.credits}`);

  const stored = await BankStatementEntry.find({ accountNumber: ACCOUNT }).sort({ amount: 1 }).lean();
  check("the debit is stored negative", stored[0].amount === -1000, `amount=${stored[0]?.amount}`);
  check("lines are marked as imported", stored.every((s) => s.source === "IMPORT"));
  check(
    "imported lines are available to matching",
    stored.every((s) => s.reconciliationStatus === "UNMATCHED" && s.statementVerified !== true)
  );

  console.log("\nB. re-importing the same file");
  const second = await importStatementRows({ csv: STATEMENT_CSV, accountNumber: ACCOUNT });
  check("nothing is inserted twice", second.inserted === 0, `inserted=${second.inserted}`);
  check("every line is reported as already loaded", second.duplicates === 5, `duplicates=${second.duplicates}`);
  const afterReimport = await BankStatementEntry.countDocuments({ accountNumber: ACCOUNT });
  check("the statement did not double", afterReimport === 5, `rows=${afterReimport}`);

  console.log("\nC. two identical credits on one day");
  const cashRows = stored.filter((s) => s.narration.includes("CASH DEPOSIT"));
  check(
    "both ₹500 deposits survive despite being indistinguishable",
    cashRows.length === 2,
    `kept=${cashRows.length}`
  );

  console.log("\nD. settling a payment against an imported line");
  // orderId is validated to 1000..99999, so take the first free slot below the ceiling.
  let freeOrderId = 99999;
  while (await Order.exists({ orderId: freeOrderId })) freeOrderId -= 1;

  stageOrder = await Order.create({
    ...prodOrder,
    _id: new mongoose.Types.ObjectId(),
    orderId: freeOrderId,
    payment: [
      {
        paidAmount: 2500,
        paymentDate: new Date("2027-04-01T00:00:00.000Z"),
        paymentStatus: "PENDING",
        modeOfPayment: "NEFT/RTGS",
        bankName: "ICICI",
        utrNumber: "IMPTESTUTR001",
        transactionId: "IMPTESTUTR001",
        remark: "DUMMY — statement import test",
      },
    ],
  });
  created.orders.push(stageOrder._id);
  paymentId = String(stageOrder.payment[0]._id);

  const outcome = await checkPaymentAgainstBank({
    source: "order",
    orderMongoId: String(stageOrder._id),
    paymentId,
    allowLiveLookup: false,
  });
  check("an exact UTR and amount match clears the payment", outcome.result === "VERIFIED", outcome.message || outcome.error || "");

  const refreshed = await Order.findById(stageOrder._id).lean();
  const sub = refreshed.payment.find((p) => String(p._id) === paymentId);
  check("the payment is marked bank verified", sub.bankVerificationStatus === "BANK_VERIFIED", `status=${sub.bankVerificationStatus}`);
  check("the match is attributed to the statement", sub.bankVerificationSource === "STATEMENT_API", `source=${sub.bankVerificationSource}`);
  check("matchedBy stays inside the schema enum", sub.bankVerificationMatchedBy === "UTR", `matchedBy=${sub.bankVerificationMatchedBy}`);

  const usedLine = await BankStatementEntry.findOne({ accountNumber: ACCOUNT, referenceNumber: "IMPTESTUTR001" }).lean();
  check("the consumed credit is no longer unmatched", usedLine.reconciliationStatus !== "UNMATCHED", `status=${usedLine.reconciliationStatus}`);

  console.log("\nE. a file that is not a statement");
  const junk = await importStatementRows({ csv: "name,qty\nwidget,3", accountNumber: ACCOUNT });
  check("is rejected with an explanation", junk.ok === false && /header row/i.test(junk.error || ""), junk.error || "");
  const noAccount = await importStatementRows({ csv: STATEMENT_CSV });
  check("an import without an account is refused", noAccount.ok === false, noAccount.error || "");
  } finally {
    await cleanup();
  }

  await mongoose.disconnect();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
    process.exit(1);
  }
}

run().catch(async (e) => {
  console.error("\nFATAL", e);
  try {
    await mongoose.disconnect();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
