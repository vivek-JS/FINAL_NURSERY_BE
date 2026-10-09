import SuspenseEntry from "../models/suspenseEntry.model.js";
import BankStatementEntry from "../../../models/bankStatementEntry.model.js";
import Order from "../../../models/order.model.js";
import AgriSalesOrder from "../../../models/agriSalesOrder.model.js";
import { transitionPaymentStatus } from "./verificationStatusEngine.js";

const ACTIVE = ["OPEN", "IN_REVIEW"];
const CLOSED = ["RESOLVED", "WRITTEN_OFF"];

function getPaymentUtr(p) {
  return (
    (p?.utrNumber && String(p.utrNumber).trim()) ||
    (p?.transactionId && String(p.transactionId).trim()) ||
    ""
  );
}

/**
 * Route payment or bank line to suspense queue for manual approval.
 *
 * A row an accountant already closed for the same payment, line and reason is
 * not reopened: the batch runs every day and would otherwise put back what the
 * accountant just dismissed. Rows the engine closed itself (`closedBy: SYSTEM`)
 * do reopen, since nobody looked at them.
 *
 * Routing a payment for a new reason supersedes its other open rows, and
 * offering a line to a payment supersedes that line's orphan-credit row, so one
 * problem shows up once in the queue.
 *
 * @returns {Promise<{ created: boolean, decided?: boolean, entry: object }>}
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

  const identity = {
    ...(payment?.paymentId ? { paymentId: payment.paymentId } : {}),
    ...(bankEntry?._id ? { bankTransactionId: bankEntry._id } : {}),
    reason,
  };

  const existing = await SuspenseEntry.findOne({ ...identity, status: { $in: ACTIVE } });
  if (existing) return { created: false, entry: existing };

  const decided = await SuspenseEntry.findOne({
    ...identity,
    status: { $in: CLOSED },
    closedBy: { $ne: "SYSTEM" },
  });
  if (decided) return { created: false, decided: true, entry: decided };

  const superseded = [];
  if (payment?.paymentId) {
    superseded.push(
      ...(await SuspenseEntry.find({
        paymentId: payment.paymentId,
        status: { $in: ACTIVE },
        reason: { $ne: reason },
      }))
    );
  }
  if (payment?.paymentId && bankEntry?._id) {
    superseded.push(
      ...(await SuspenseEntry.find({
        bankTransactionId: bankEntry._id,
        status: { $in: ACTIVE },
        reason: "ORPHAN_CREDIT",
      }))
    );
  }

  const entry = await SuspenseEntry.create({
    bankTransactionId: bankEntry?._id || null,
    paymentId: payment?.paymentId || null,
    orderMongoId: payment?.orderMongoId || null,
    orderId: payment?.orderId != null ? String(payment.orderId) : undefined,
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

  await closeBySystem(superseded, `Superseded by ${reason}`, bankEntry?._id);

  if (bankEntry?._id) {
    await BankStatementEntry.updateOne(
      { _id: bankEntry._id, reconciliationStatus: { $ne: "MATCHED" } },
      { reconciliationStatus: "SUSPENSE" }
    );
  }

  if (payment?.paymentId) {
    await setPaymentBankFlags(payment, { status: "VERIFY_FAILED", conflict: true });
  }

  return { created: true, entry };
}

/**
 * Close every open row for a payment or a bank line once the engine has
 * matched them. Called after an automatic UTR match.
 *
 * @param {{ paymentId?: string, bankTransactionId?: any, note?: string }} args
 */
export async function closeOpenSuspenseFor({ paymentId, bankTransactionId, note }) {
  const or = [];
  if (paymentId) or.push({ paymentId });
  if (bankTransactionId) or.push({ bankTransactionId });
  if (!or.length) return 0;

  const rows = await SuspenseEntry.find({ status: { $in: ACTIVE }, $or: or });
  await closeBySystem(rows, note || "Matched automatically", bankTransactionId);
  return rows.length;
}

async function closeBySystem(rows, note, keepLineId) {
  const now = new Date();
  for (const row of rows) {
    row.status = "RESOLVED";
    row.closedBy = "SYSTEM";
    row.resolvedAt = now;
    row.resolutionNotes = note;
    await row.save();
  }
  const keep = keepLineId ? String(keepLineId) : null;
  for (const row of rows) {
    if (row.bankTransactionId && String(row.bankTransactionId) !== keep) {
      await releaseLine(row.bankTransactionId);
    }
    if (row.paymentId && row.orderMongoId) await releasePayment(row);
  }
}

/**
 * Hand a payment back to the Pending tab once no open row holds it. A payment
 * the engine verified is no longer PENDING and is left alone.
 */
async function releasePayment(row) {
  const stillHeld = await SuspenseEntry.exists({
    paymentId: row.paymentId,
    status: { $in: ACTIVE },
  });
  if (stillHeld) return;
  await setPaymentBankFlags(
    { source: row.source, orderMongoId: row.orderMongoId, paymentId: row.paymentId },
    { status: "PENDING", conflict: false, onlyFrom: "VERIFY_FAILED" }
  );
}

/** Put a SUSPENSE line back to UNMATCHED once no open row refers to it. */
async function releaseLine(lineId) {
  const stillOpen = await SuspenseEntry.exists({
    bankTransactionId: lineId,
    status: { $in: ACTIVE },
  });
  if (stillOpen) return;
  await BankStatementEntry.updateOne(
    { _id: lineId, reconciliationStatus: "SUSPENSE" },
    { reconciliationStatus: "UNMATCHED" }
  );
}

async function setPaymentBankFlags(pay, { status, conflict, onlyFrom }) {
  if (!["order", "agriSales"].includes(pay.source)) return;
  const Model = pay.source === "order" ? Order : AgriSalesOrder;
  const order = await Model.findById(pay.orderMongoId);
  if (!order) return;
  const sub = order.payment.id(pay.paymentId);
  if (!sub || sub.paymentStatus !== "PENDING") return;
  if (onlyFrom && sub.bankVerificationStatus !== onlyFrom) return;
  sub.bankVerificationStatus = status;
  sub.bankReconciliationConflict = conflict;
  await order.save();
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
  if (!ACTIVE.includes(entry.status)) {
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
  entry.closedBy = "USER";
  entry.resolvedAt = new Date();
  entry.resolutionNotes = resolutionNotes || `Linked to payment ${paymentId}`;
  entry.paymentId = paymentId;
  entry.orderMongoId = orderMongoId;
  entry.source = source;
  entry.assignedTo = userId || entry.assignedTo;
  await entry.save();

  await closeOpenSuspenseFor({
    paymentId,
    bankTransactionId: bankEntry?._id,
    note: `Linked to payment ${paymentId} from another suspense row`,
  });

  return { ok: true, entry: entry.toObject() };
}

/**
 * Close a suspense row without linking it.
 *
 * - A bank-only line (orphan credit) is set to IGNORED, so the next run does
 *   not put it straight back.
 * - A payment goes back to the Pending tab (bank verification PENDING) unless
 *   another open row still holds it, so it is never left stuck as VERIFY_FAILED.
 * - A line that was offered to a payment returns to UNMATCHED and can match
 *   something else; the rejected pairing itself is not offered again.
 */
export async function resolveSuspense(suspenseId, { resolutionNotes, userId, action }) {
  const entry = await SuspenseEntry.findById(suspenseId);
  if (!entry) return { ok: false, error: "Not found", code: "NOT_FOUND" };
  if (!ACTIVE.includes(entry.status)) {
    return { ok: false, error: `Suspense entry is already ${entry.status}` };
  }

  entry.status = action === "WRITE_OFF" ? "WRITTEN_OFF" : "RESOLVED";
  entry.closedBy = "USER";
  entry.resolvedAt = new Date();
  entry.resolutionNotes = resolutionNotes || "";
  entry.assignedTo = userId || entry.assignedTo;
  await entry.save();

  if (entry.paymentId && entry.orderMongoId) await releasePayment(entry);

  if (entry.bankTransactionId) {
    if (entry.paymentId) {
      await releaseLine(entry.bankTransactionId);
    } else {
      await BankStatementEntry.updateOne(
        { _id: entry.bankTransactionId, reconciliationStatus: { $ne: "MATCHED" } },
        { reconciliationStatus: "IGNORED" }
      );
    }
  }

  return { ok: true, entry };
}
