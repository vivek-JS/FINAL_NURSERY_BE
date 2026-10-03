import SuspenseEntry from "../models/suspenseEntry.model.js";
import BankStatementEntry from "../../../models/bankStatementEntry.model.js";
import Order from "../../../models/order.model.js";
import AgriSalesOrder from "../../../models/agriSalesOrder.model.js";
import { transitionPaymentStatus } from "./verificationStatusEngine.js";

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

/**
 * Resolve a suspense row by pointing it at the payment it belongs to.
 * The accountant made the call, so the payment is recorded as manually verified.
 *
 * @param {string} suspenseId
 * @param {{ source: "order"|"agriSales", orderMongoId: string, paymentId: string, resolutionNotes?: string, userId?: string }} args
 */
export async function linkSuspenseToPayment(
  suspenseId,
  { source, orderMongoId, paymentId, resolutionNotes, userId }
) {
  const entry = await SuspenseEntry.findById(suspenseId);
  if (!entry) return { ok: false, error: "Suspense entry not found" };
  if (entry.status !== "OPEN" && entry.status !== "IN_REVIEW") {
    return { ok: false, error: `Suspense entry is already ${entry.status}` };
  }
  if (!["order", "agriSales"].includes(source) || !orderMongoId || !paymentId) {
    return { ok: false, error: "source, orderMongoId and paymentId are required" };
  }

  const bankEntry = entry.bankTransactionId
    ? await BankStatementEntry.findById(entry.bankTransactionId).lean()
    : null;

  const transition = await transitionPaymentStatus({
    pay: { source, orderMongoId, paymentId },
    targetStatus: "BANK_VERIFIED",
    bankEntry,
    matchedBy: "AMOUNT_DATE",
    source: "MANUAL",
  });
  if (!transition.ok) return { ok: false, error: transition.error };

  if (bankEntry?._id) {
    await BankStatementEntry.updateOne(
      { _id: bankEntry._id },
      { reconciliationStatus: "MATCHED", matchedPaymentId: paymentId }
    );
  }

  entry.status = "RESOLVED";
  entry.resolvedAt = new Date();
  entry.resolutionNotes = resolutionNotes || `Linked to payment ${paymentId}`;
  entry.paymentId = paymentId;
  entry.orderMongoId = orderMongoId;
  entry.source = source;
  entry.assignedTo = userId || entry.assignedTo;
  await entry.save();

  return { ok: true, entry: entry.toObject() };
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
