/**
 * Payment verification status engine.
 *
 * PENDING → BANK_VERIFIED → COLLECTED (COLLECTED is existing accountant step)
 * PENDING → SUSPENSE (via suspense.service)
 */

import Order from "../../../models/order.model.js";
import AgriSalesOrder from "../../../models/agriSalesOrder.model.js";

export async function transitionPaymentStatus({
  pay,
  targetStatus,
  bankEntry,
  matchedBy,
  source = "STATEMENT_API",
}) {
  if (!pay || !targetStatus) {
    return { ok: false, error: "Invalid transition params" };
  }

  if (targetStatus === "BANK_VERIFIED") {
    if (pay.source === "order") {
      const order = await Order.findById(pay.orderMongoId);
      if (!order) return { ok: false, error: "Order not found" };
      const subdoc = order.payment.id(pay.paymentId);
      if (!subdoc || subdoc.paymentStatus !== "PENDING") {
        return { ok: false, error: "Payment not in PENDING state" };
      }
      subdoc.paymentStatus = "BANK_VERIFIED";
      subdoc.bankVerificationStatus = "BANK_VERIFIED";
      subdoc.bankVerificationSource = source;
      subdoc.bankVerificationMatchedBy = matchedBy;
      if (bankEntry) {
        subdoc.bankReferenceNumber = bankEntry.referenceNumber || "";
        subdoc.bankNarration = bankEntry.narration || "";
        subdoc.bankAmount = bankEntry.amount;
        subdoc.bankEntryDate = bankEntry.txnDate;
        subdoc.bankRawResponse = bankEntry.rawResponse || bankEntry;
      }
      subdoc.bankReconciliationConflict = false;
      await order.save();

      try {
        const fs = await import("../../finance/integration/financeShadow.js");
        await fs.shadowBankPaymentVerified({
          paymentId: pay.paymentId,
          orderMongoId: pay.orderMongoId,
          amount: pay.paidAmount,
          userId: null,
        });
      } catch (shadowErr) {
        console.error("[Finance] shadow bank verify:", shadowErr?.message || shadowErr);
      }
    } else {
      const order = await AgriSalesOrder.findById(pay.orderMongoId);
      if (!order) return { ok: false, error: "Agri order not found" };
      const subdoc = order.payment.id(pay.paymentId);
      if (!subdoc || subdoc.paymentStatus !== "PENDING") {
        return { ok: false, error: "Payment not in PENDING state" };
      }
      subdoc.paymentStatus = "BANK_VERIFIED";
      subdoc.bankVerificationStatus = "BANK_VERIFIED";
      subdoc.bankVerificationSource = source;
      subdoc.bankVerificationMatchedBy = matchedBy;
      if (bankEntry) {
        subdoc.bankReferenceNumber = bankEntry.referenceNumber || "";
        subdoc.bankNarration = bankEntry.narration || "";
        subdoc.bankAmount = bankEntry.amount;
        subdoc.bankEntryDate = bankEntry.txnDate;
        subdoc.bankRawResponse = bankEntry.rawResponse || bankEntry;
      }
      subdoc.bankReconciliationConflict = false;
      await order.save();

      try {
        const fs = await import("../../finance/integration/financeShadow.js");
        await fs.shadowBankPaymentVerified({
          paymentId: pay.paymentId,
          orderMongoId: pay.orderMongoId,
          amount: pay.paidAmount,
          userId: null,
        });
      } catch (shadowErr) {
        console.error("[Finance] shadow bank verify agri:", shadowErr?.message || shadowErr);
      }
    }
  }

  return { ok: true, status: targetStatus };
}

/**
 * Verify via Transaction Status API then promote to BANK_VERIFIED.
 */
export async function verifyViaStatusApi(pay, statusResult) {
  const successStatuses = new Set(["SUCCESS", "COMPLETED", "CREDITED", "SETTLED"]);
  if (!successStatuses.has(String(statusResult.status).toUpperCase())) {
    return { ok: false, error: `Status API returned ${statusResult.status}` };
  }

  return transitionPaymentStatus({
    pay,
    targetStatus: "BANK_VERIFIED",
    matchedBy: "TXN_STATUS_API",
    source: "TXN_STATUS_API",
    bankEntry: {
      referenceNumber: statusResult.utr,
      amount: statusResult.amount,
      txnDate: new Date(),
      narration: "Verified via ICICI Transaction Status API",
      rawResponse: statusResult.raw,
    },
  });
}
