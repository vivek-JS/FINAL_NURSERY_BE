/**
 * Open statement lines an accountant can confirm against one payment.
 * Only lines that are not reconciled yet. Same UTR, or the same amount.
 */

import BankStatementEntry, { NOT_STATEMENT_VERIFIED } from "../../../models/bankStatementEntry.model.js";
import { normalizeAmount } from "../../../services/iciciBankService.js";
import { statementLookupKeys } from "./statementClaim.service.js";

const OPEN = ["UNMATCHED", "SUSPENSE"];
const LIMIT = 25;

function present(entry, paidAmount) {
  const amount = Number(entry.amount);
  return {
    statementLineId: String(entry._id),
    txnDate: entry.txnDate,
    amount,
    utr: entry.utr || entry.referenceNumber || "",
    transactionId: entry.transactionId || "",
    narration: String(entry.narration || "").slice(0, 90),
    amountMatches: Math.abs(amount - normalizeAmount(paidAmount)) < 0.02,
  };
}

export async function listOpenMatches(pay) {
  const keys = statementLookupKeys(pay);
  const amount = normalizeAmount(pay.paidAmount);
  const or = [];
  if (keys.length) {
    or.push(
      { utr: { $in: keys } },
      { referenceNumber: { $in: keys } },
      { transactionId: { $in: keys } },
      { chequeNumber: { $in: keys } }
    );
  }
  if (Number.isFinite(amount)) {
    or.push({ amount: { $gte: amount - 0.02, $lte: amount + 0.02 } });
  }
  if (!or.length) return [];

  const lines = await BankStatementEntry.find({
    ...NOT_STATEMENT_VERIFIED,
    reconciliationStatus: { $in: OPEN },
    $or: or,
  })
    .sort({ txnDate: -1 })
    .limit(LIMIT)
    .select("txnDate amount utr referenceNumber transactionId chequeNumber narration")
    .lean();

  const seen = new Set();
  return lines
    .filter((line) => {
      const id = String(line._id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((line) => present(line, pay.paidAmount));
}
