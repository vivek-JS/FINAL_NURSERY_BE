/**
 * A bank line may clear only one payment. The claim is the lock:
 * the first checker marks the line MATCHED, and a second checker cannot take it.
 */

import BankStatementEntry from "../../../models/bankStatementEntry.model.js";
import { normalizeUtr } from "../../../services/iciciBankService.js";

const OPEN = ["UNMATCHED", "SUSPENSE"];

export async function claimStatementLine(entryId, paymentId, userId) {
  return BankStatementEntry.findOneAndUpdate(
    {
      _id: entryId,
      reconciliationStatus: { $in: OPEN },
      statementVerified: { $ne: true },
    },
    {
      $set: {
        reconciliationStatus: "MATCHED",
        matchedPaymentId: String(paymentId),
        statementVerified: true,
        statementVerifiedAt: new Date(),
        statementVerifiedBy: userId || null,
      },
    },
    { new: true }
  ).lean();
}

export async function releaseStatementLine(entryId, paymentId) {
  await BankStatementEntry.updateOne(
    { _id: entryId, matchedPaymentId: String(paymentId), reconciliationStatus: "MATCHED" },
    {
      $set: {
        reconciliationStatus: "UNMATCHED",
        matchedPaymentId: "",
        statementVerified: false,
        statementVerifiedAt: null,
        statementVerifiedBy: null,
      },
    }
  );
}

/**
 * References to look up on open statement lines.
 * A field that contains both a bank id and "UTR 9202…" contributes each piece.
 */
export function statementLookupKeys(pay) {
  const raw = [pay?.utrNumber, pay?.transactionId, pay?.chequeNumber, pay?.qrReferenceId]
    .map((value) => (value == null ? "" : String(value).trim()))
    .filter((value) => value.length >= 6);
  const keys = new Set();
  for (const value of raw) {
    keys.add(value);
    const normalized = normalizeUtr(value);
    if (normalized.length >= 6) keys.add(normalized);
    const parts = value.split(/[·|]/);
    for (const part of parts) {
      const piece = normalizeUtr(part.replace(/UTR/gi, ""));
      if (piece.length >= 6) keys.add(piece);
    }
    const labeled = value.match(/UTR\s*[:\-]?\s*([A-Za-z0-9]{8,22})/i);
    if (labeled) keys.add(normalizeUtr(labeled[1]));
  }
  return [...keys];
}

/** Prefer the 12-digit UTR when the saved field also contains a bank transaction id. */
export function primaryStatementUtr(pay) {
  const digits = statementLookupKeys(pay).find((key) => /^\d{12}$/.test(key));
  return digits || "";
}

/** A UTR already locked to a payment must not clear a second one. */
export async function findConsumedStatementLine(pay) {
  const keys = statementLookupKeys(pay);
  if (!keys.length) return null;

  return BankStatementEntry.findOne({
    reconciliationStatus: "MATCHED",
    $or: [
      { utr: { $in: keys } },
      { referenceNumber: { $in: keys } },
      { transactionId: { $in: keys } },
      { chequeNumber: { $in: keys } },
    ],
  })
    .select("matchedPaymentId utr referenceNumber amount txnDate")
    .lean();
}
