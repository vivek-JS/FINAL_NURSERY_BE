/**
 * Accountant picked one open statement line. That line is locked to this
 * payment and cannot clear a second one.
 */

import BankStatementEntry, { NOT_STATEMENT_VERIFIED } from "../../../models/bankStatementEntry.model.js";
import { claimStatementLine, releaseStatementLine } from "./statementClaim.service.js";
import { transitionPaymentStatus } from "./verificationStatusEngine.js";

const OPEN = ["UNMATCHED", "SUSPENSE"];

export async function confirmOpenStatementLine({
  source,
  orderMongoId,
  paymentId,
  statementLineId,
  userId,
}) {
  if (!["order", "agriSales"].includes(source) || !orderMongoId || !paymentId || !statementLineId) {
    return { ok: false, error: "source, orderMongoId, paymentId and statementLineId are required" };
  }

  const line = await BankStatementEntry.findOne({
    _id: statementLineId,
    ...NOT_STATEMENT_VERIFIED,
    reconciliationStatus: { $in: OPEN },
  }).lean();
  if (!line) return { ok: false, error: "That bank line is no longer open" };

  const claimed = await claimStatementLine(line._id, paymentId, userId);
  if (!claimed) return { ok: false, error: "That bank line is already matched to another payment" };

  const transition = await transitionPaymentStatus({
    pay: { source, orderMongoId, paymentId, paidAmount: line.amount },
    targetStatus: "BANK_VERIFIED",
    bankEntry: line,
    matchedBy: "AMOUNT_DATE",
    source: "MANUAL",
  });
  if (!transition.ok) {
    await releaseStatementLine(line._id, paymentId);
    return { ok: false, error: transition.error };
  }

  return {
    ok: true,
    result: "VERIFIED",
    message: "Matched the selected bank line.",
    bankAmount: line.amount,
    statementLineId: String(line._id),
  };
}
