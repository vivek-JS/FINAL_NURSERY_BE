import crypto from "crypto";
import BankStatementEntry from "../../../models/bankStatementEntry.model.js";
import { normalizeUtr, normalizeAmount } from "../../../services/iciciBankService.js";

/**
 * Build composite duplicate key: account + UTR + amount + date
 */
export function buildDuplicateKey({ accountNumber, referenceNumber, amount, txnDate }) {
  const d = txnDate instanceof Date ? txnDate : new Date(txnDate);
  const dateStr = d.toISOString().slice(0, 10);
  const utr = normalizeUtr(referenceNumber);
  const amt = normalizeAmount(amount);
  const acct = String(accountNumber || "DEFAULT").trim();

  return crypto
    .createHash("sha256")
    .update(`${acct}|${utr}|${amt}|${dateStr}`)
    .digest("hex");
}

/**
 * Idempotent insert — skips duplicates by duplicateKey or entryHash.
 * One write for the whole batch so a 2,000-line sandbox statement does not
 * sit on the request for a minute (nginx's default read timeout is 60s).
 */
export async function safeInsertBankTransactions(entries) {
  const docs = entries.map((e) => {
    const duplicateKey =
      e.duplicateKey ||
      buildDuplicateKey({
        accountNumber: e.accountNumber,
        referenceNumber: e.referenceNumber,
        amount: e.amount,
        txnDate: e.txnDate,
      });
    return {
      txnDate: e.txnDate,
      amount: e.amount,
      referenceNumber: e.referenceNumber || "",
      narration: e.narration || "",
      txnType: e.txnType || "",
      balance: e.balance,
      transactionId: e.transactionId || "",
      chequeNumber: e.chequeNumber || "",
      entryHash: e.entryHash,
      duplicateKey,
      accountNumber: e.accountNumber || "",
      utr: normalizeUtr(e.referenceNumber),
      source: e.source || "CORPORATE_HTTP",
      reconciliationStatus: "UNMATCHED",
      rawResponse: e.rawResponse,
    };
  });

  if (!docs.length) return { inserted: 0, skipped: 0, total: 0, duplicates: [] };

  try {
    const written = await BankStatementEntry.insertMany(docs, { ordered: false });
    return { inserted: written.length, skipped: 0, total: docs.length, duplicates: [] };
  } catch (err) {
    const duplicateError =
      err.code === 11000 ||
      err.name === "MongoBulkWriteError" ||
      (Array.isArray(err.writeErrors) && err.writeErrors.some((w) => w.code === 11000));
    if (!duplicateError) throw err;

    const inserted = err.result?.insertedCount ?? err.insertedCount ?? 0;
    const skipped = docs.length - inserted;
    return {
      inserted,
      skipped,
      total: docs.length,
      duplicates: (err.writeErrors || [])
        .filter((w) => w.code === 11000)
        .slice(0, 20)
        .map((w) => ({ index: w.index })),
    };
  }
}

export async function findDuplicateByComposite({ accountNumber, utr, amount, txnDate }) {
  const duplicateKey = buildDuplicateKey({
    accountNumber,
    referenceNumber: utr,
    amount,
    txnDate,
  });
  return BankStatementEntry.findOne({ duplicateKey }).lean();
}
