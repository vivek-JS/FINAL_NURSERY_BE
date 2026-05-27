import SuspenseEntry from "../models/suspenseEntry.model.js";
import BankStatementEntry from "../../../models/bankStatementEntry.model.js";
import Order from "../../../models/order.model.js";
import AgriSalesOrder from "../../../models/agriSalesOrder.model.js";

function getPaymentUtr(p) {
  return (
    (p?.utrNumber && String(p.utrNumber).trim()) ||
    (p?.transactionId && String(p.transactionId).trim()) ||
    ""
  );
}

/**
 * Route payment or bank line to suspense queue for manual approval.
 */
export async function routeToSuspense({
  payment,
  bankEntry,
  reason,
  confidenceScore,
  candidates,
  runId,
}) {
  const utr = payment ? getPaymentUtr(payment) : bankEntry?.referenceNumber || "";
  const amount = payment?.paidAmount ?? bankEntry?.amount ?? 0;

  const existing = await SuspenseEntry.findOne({
    status: "OPEN",
    ...(payment?.paymentId ? { paymentId: payment.paymentId } : {}),
    ...(bankEntry?._id ? { bankTransactionId: bankEntry._id } : {}),
    reason,
  });

  if (existing) return { created: false, entry: existing };

  const entry = await SuspenseEntry.create({
    bankTransactionId: bankEntry?._id || null,
    paymentId: payment?.paymentId || null,
    orderMongoId: payment?.orderMongoId || null,
    source: payment?.source || (bankEntry ? "bank_only" : "order"),
    reason,
    status: "OPEN",
    utr,
    amount,
    accountNumber: bankEntry?.accountNumber || "",
    txnDate: bankEntry?.txnDate || payment?.paymentDate,
    narration: bankEntry?.narration || "",
    confidenceScore: confidenceScore ?? null,
    metadata: { runId, candidates: candidates?.map((c) => ({ score: c.score, rule: c.rule })) },
  });

  if (bankEntry?._id) {
    await BankStatementEntry.updateOne(
      { _id: bankEntry._id },
      { reconciliationStatus: "SUSPENSE" }
    );
  }

  if (payment?.paymentId) {
    await markPaymentSuspense(payment);
  }

  return { created: true, entry };
}

async function markPaymentSuspense(pay) {
  if (pay.source === "order") {
    const order = await Order.findById(pay.orderMongoId);
    if (!order) return;
    const sub = order.payment.id(pay.paymentId);
    if (!sub || sub.paymentStatus !== "PENDING") return;
    sub.bankVerificationStatus = "VERIFY_FAILED";
    sub.bankReconciliationConflict = true;
    await order.save();
  } else {
    const order = await AgriSalesOrder.findById(pay.orderMongoId);
    if (!order) return;
    const sub = order.payment.id(pay.paymentId);
    if (!sub || sub.paymentStatus !== "PENDING") return;
    sub.bankVerificationStatus = "VERIFY_FAILED";
    sub.bankReconciliationConflict = true;
    await order.save();
  }
}

export async function listOpenSuspense({ limit = 100, skip = 0 } = {}) {
  return SuspenseEntry.find({ status: "OPEN" })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
}

export async function resolveSuspense(suspenseId, { resolutionNotes, userId, action }) {
  const entry = await SuspenseEntry.findById(suspenseId);
  if (!entry) return { ok: false, error: "Not found" };

  entry.status = action === "WRITE_OFF" ? "WRITTEN_OFF" : "RESOLVED";
  entry.resolvedAt = new Date();
  entry.resolutionNotes = resolutionNotes || "";
  entry.assignedTo = userId || entry.assignedTo;
  await entry.save();

  return { ok: true, entry };
}
