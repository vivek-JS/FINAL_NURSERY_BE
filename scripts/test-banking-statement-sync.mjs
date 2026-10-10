/**
 * Statement sync dedupe against a throwaway local database (dropped at the end).
 *
 * Scenario: sync today → 4 lines; later the bank has 6 → only 2 are added;
 * re-sync adds nothing; two genuine identical no-reference cash deposits stay
 * two lines; a CSV import of lines the API already saved adds nothing; lines
 * saved under the old key scheme are still recognised.
 *
 * Usage: node scripts/test-banking-statement-sync.mjs
 */
import crypto from "crypto";
import mongoose from "mongoose";

const BASE = process.env.BANKING_TEST_MONGO_URL || "mongodb://127.0.0.1:27017";
const DB_NAME = `banking_statement_test_${Date.now()}`;
const ACCT = "000405001234";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

await mongoose.connect(`${BASE}/${DB_NAME}`);
const { default: BankStatementEntry } = await import("../models/bankStatementEntry.model.js");
await BankStatementEntry.init();
const { safeInsertBankTransactions, buildDuplicateKey } = await import(
  "../modules/banking/services/duplicateDetection.service.js"
);
const { normaliseStatementRow } = await import("../services/iciciStatement.service.js");
const { importStatementRows } = await import("../modules/banking/services/bankStatement.service.js");

/** Rows the way ICICI CIB_SV sends them. */
const icici = (rows) =>
  rows.map((r, i) => ({ ...normaliseStatementRow(r, i), accountNumber: ACCT, source: "CORPORATE_HTTP" }));
const count = () => BankStatementEntry.countDocuments({ accountNumber: ACCT });

const morning = [
  { TXNDATE: "10-10-2026 09:01:00", REMARKS: "UPI/373122371894/rakesh/IDFC", AMOUNT: "1500.00", TYPE: "CR", TRANSACTIONID: "S1001" },
  { TXNDATE: "10-10-2026 09:20:00", REMARKS: "NEFT/SBINN52026101000123/FARMER", AMOUNT: "25000.00", TYPE: "CR", TRANSACTIONID: "S1002" },
  { TXNDATE: "10-10-2026 09:45:00", REMARKS: "BY CASH DEPOSIT", AMOUNT: "500.00", TYPE: "CR", TRANSACTIONID: "S1003" },
  { TXNDATE: "10-10-2026 10:05:00", REMARKS: "INF/NEFT/034858232391/VENDOR", AMOUNT: "1200.00", TYPE: "DR", TRANSACTIONID: "S1004" },
];
const afternoon = [
  { TXNDATE: "10-10-2026 13:10:00", REMARKS: "UPI/373122379999/sunita/HDFC", AMOUNT: "800.00", TYPE: "CR", TRANSACTIONID: "S1005" },
  { TXNDATE: "10-10-2026 14:30:00", REMARKS: "BY CASH DEPOSIT", AMOUNT: "500.00", TYPE: "CR", TRANSACTIONID: "S1006" },
];

try {
  console.log("Sync today, then again after new lines arrive");
  const first = await safeInsertBankTransactions(icici(morning));
  check("10 AM sync saves 4", first.inserted === 4 && (await count()) === 4, JSON.stringify(first));

  // Newest-first this time, so every line sits at a different position.
  const second = await safeInsertBankTransactions(icici([...morning, ...afternoon].reverse()));
  check(
    "3 PM sync saves only the 2 new lines",
    second.inserted === 2 && second.alreadySaved === 4 && (await count()) === 6,
    JSON.stringify(second)
  );
  const cash = await BankStatementEntry.countDocuments({ accountNumber: ACCT, amount: 500 });
  check("second ₹500 cash deposit (own transaction id) is kept", cash === 2);

  const third = await safeInsertBankTransactions(icici([...morning, ...afternoon]));
  check("syncing again adds nothing", third.inserted === 0 && (await count()) === 6, JSON.stringify(third));

  console.log("Bank repeats a line across pages");
  const repeated = await safeInsertBankTransactions(
    icici([{ TXNDATE: "11-10-2026", REMARKS: "UPI/373122300001/x/Y", AMOUNT: "10.00", TYPE: "CR", TRANSACTIONID: "S2001" }]).concat(
      icici([{ TXNDATE: "11-10-2026", REMARKS: "UPI/373122300001/x/Y", AMOUNT: "10.00", TYPE: "CR", TRANSACTIONID: "S2001" }])
    )
  );
  check("same transaction twice in one fetch is saved once", repeated.inserted === 1 && repeated.repeatedInBatch === 1);

  console.log("Lines with no reference at all");
  const noRef = (n) =>
    Array.from({ length: n }, () => ({
      txnDate: new Date(Date.UTC(2026, 9, 12)),
      amount: 500,
      referenceNumber: "",
      narration: "CASH DEPOSIT BRANCH",
      accountNumber: ACCT,
      source: "CORPORATE_HTTP",
    }));
  const two = await safeInsertBankTransactions(noRef(2));
  check("two identical no-reference deposits stay two lines", two.inserted === 2, JSON.stringify(two));
  const twoAgain = await safeInsertBankTransactions(noRef(2));
  check("re-sync of them adds nothing", twoAgain.inserted === 0 && twoAgain.alreadySaved === 2);
  const three = await safeInsertBankTransactions(noRef(3));
  check("a third one arriving later is added", three.inserted === 1 && three.alreadySaved === 2);

  console.log("CSV import after API sync");
  const csv = [
    "Date,Narration,Reference,Debit,Credit,Balance",
    "10-10-2026,UPI/373122371894/rakesh/IDFC,373122371894,,1500.00,",
    "10-10-2026,NEFT FARMER,SBINN52026101000123,,25000.00,",
    "13-10-2026,UPI/373122388888/new/SBI,373122388888,,640.00,",
  ].join("\n");
  const imp = await importStatementRows({ csv, accountNumber: ACCT });
  check(
    "import skips lines the API already saved, adds the new one",
    imp.ok && imp.inserted === 1 && imp.duplicates === 2,
    JSON.stringify({ ok: imp.ok, error: imp.error, inserted: imp.inserted, duplicates: imp.duplicates })
  );
  const impAgain = await importStatementRows({ csv, accountNumber: ACCT });
  check("importing the same file again adds nothing", impAgain.inserted === 0);

  console.log("Lines saved before this change");
  const legacyDate = new Date(Date.UTC(2026, 9, 14));
  await BankStatementEntry.create({
    txnDate: legacyDate,
    amount: 999,
    referenceNumber: "LEGACYUTR123456",
    utr: "LEGACYUTR123456",
    narration: "UPI/LEGACYUTR123456",
    accountNumber: ACCT,
    entryHash: crypto.randomUUID(),
    duplicateKey: buildDuplicateKey({ accountNumber: ACCT, referenceNumber: "LEGACYUTR123456", amount: 999, txnDate: legacyDate }),
    source: "CORPORATE_HTTP",
  });
  const legacy = await safeInsertBankTransactions(
    icici([{ TXNDATE: "14-10-2026", REMARKS: "UPI/LEGACYUTR123456", AMOUNT: "999", TYPE: "CR", TRANSACTIONID: "S3001" }])
  );
  check("old line (no transaction id) is recognised by UTR", legacy.inserted === 0 && legacy.alreadySaved === 1);

  console.log("Two syncs at the same moment");
  const burst = icici([{ TXNDATE: "15-10-2026", REMARKS: "UPI/373122377777/a/B", AMOUNT: "77.00", TYPE: "CR", TRANSACTIONID: "S4001" }]);
  const [a, b] = await Promise.all([safeInsertBankTransactions(burst), safeInsertBankTransactions(burst)]);
  check(
    "only one copy is saved",
    a.inserted + b.inserted === 1 && (await BankStatementEntry.countDocuments({ transactionId: "S4001" })) === 1,
    JSON.stringify([a.inserted, b.inserted])
  );
} catch (err) {
  console.error("RUN ERROR:", err.stack || err.message);
  check("run completed", false, err.message);
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
