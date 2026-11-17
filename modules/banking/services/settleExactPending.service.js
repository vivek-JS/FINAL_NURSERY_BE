/**
 * A pending payment whose UTR or transaction id is already on the statement
 * (same amount) is bank-verified and leaves the "not in bank" list.
 */

import { checkPaymentAgainstBank } from "./paymentBankCheck.service.js";
import { transitionPaymentStatus } from "./verificationStatusEngine.js";
import BankStatementEntry from "../../../models/bankStatementEntry.model.js";

export async function settleExactPending(rows, userId) {
  let settled = 0;
  for (const row of rows || []) {
    if (row.statementMatch !== "EXACT") continue;
    try {
      if (row.statementMatchedPaymentId && row.statementMatchedPaymentId !== String(row.paymentId)) {
        continue;
      }
      if (row.statementMatchedPaymentId === String(row.paymentId)) {
        const line = row.statementLineId
          ? await BankStatementEntry.findById(row.statementLineId).lean()
          : null;
        const done = await transitionPaymentStatus({
          pay: {
            source: row.source,
            orderMongoId: row.orderMongoId,
            paymentId: row.paymentId,
            paidAmount: row.paidAmount,
          },
          targetStatus: "BANK_VERIFIED",
          bankEntry: line,
          matchedBy: "UTR",
          source: "STATEMENT_API",
        });
        if (done.ok) settled += 1;
        continue;
      }
      const result = await checkPaymentAgainstBank({
        source: row.source,
        orderMongoId: row.orderMongoId,
        paymentId: row.paymentId,
        userId: userId || null,
      });
      if (result?.result === "VERIFIED") settled += 1;
    } catch (err) {
      console.error("[Banking] settle exact pending:", err?.message || err);
    }
  }
  return settled;
}
