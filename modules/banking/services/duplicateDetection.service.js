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
 */
export async function safeInsertBankTransactions(entries) {
  let inserted = 0;
  let skipped = 0;
  const duplicates = [];

  for (const e of entries) {
    const duplicateKey =
      e.duplicateKey ||
      buildDuplicateKey({
        accountNumber: e.accountNumber,
        referenceNumber: e.referenceNumber,
        amount: e.amount,
        txnDate: e.txnDate,
      });

    try {
      await BankStatementEntry.create({
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
      });
      inserted += 1;
    } catch (err) {
      if (err.code === 11000) {
        skipped += 1;
        duplicates.push({ duplicateKey, referenceNumber: e.referenceNumber });
      } else {
        throw err;
      }
    }
  }

  return { inserted, skipped, total: entries.length, duplicates };
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
