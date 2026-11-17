/**
 * On-demand bank check for a single payment.
 *
 * The batch engine walks every pending payment on a schedule; this runs the same
 * matching for one payment the moment an accountant asks, using the UTR and amount
 * the receipt OCR already captured.
 *
 * Order of attempts:
 *   1. Stored statement lines (same scoring as the batch engine)
 *   2. Latest ICICI account statement, then the same match again
 */

import crypto from "crypto";
import Order from "../../../models/order.model.js";
import AgriSalesOrder from "../../../models/agriSalesOrder.model.js";
import BankStatementEntry, {
  NOT_STATEMENT_VERIFIED,
} from "../../../models/bankStatementEntry.model.js";
import {
  scoreMatch,
  applyMatch,
  qualifiesForAutoVerify,
} from "./reconciliationEngine.service.js";
import { normalizeAmount, normalizeUtr } from "../../../services/iciciBankService.js";
import {
  findConsumedStatementLine,
  primaryStatementUtr,
  statementLookupKeys,
} from "./statementClaim.service.js";
import { listOpenMatches } from "./openStatementLines.service.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

const AMOUNT_EPS = 0.02;

export const CHECK_RESULT = {
  VERIFIED: "VERIFIED",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  MULTIPLE_MATCH: "MULTIPLE_MATCH",
  /** A credit was found but not on a UTR, so an accountant must confirm it. */
  NEEDS_REVIEW: "NEEDS_REVIEW",
  NOT_FOUND: "NOT_FOUND",
  /** Open statement lines exist, but none is an exact UTR. The accountant picks one. */
  NEEDS_CONFIRMATION: "NEEDS_CONFIRMATION",
};

/** Plain-English reason a candidate was not good enough to clear by itself. */
function whyNotAutoVerified(match) {
  if (match.rule === "TXN_ID_AMOUNT") {
    return "matched on the bank's transaction id, not a UTR";
  }
  if (match.rule === "CHEQUE_AMOUNT") {
    return "matched on cheque number, not a UTR";
  }
  return `matched only on amount and date (confidence ${match.score})`;
}

function paymentUtr(p) {
  return (
    (p?.utrNumber && String(p.utrNumber).trim()) ||
    (p?.transactionId && String(p.transactionId).trim()) ||
    (p?.qrReferenceId && String(p.qrReferenceId).trim()) ||
    ""
  );
}

/**
 * Load one payment in the shape the matching engine expects.
 * @returns {Promise<object|null>}
 */
async function loadPayment({ source, orderMongoId, paymentId }) {
  if (source === "order") {
    const order = await Order.findById(orderMongoId)
      .select("orderId payment farmer")
      .populate("farmer", "name village")
      .lean();
    const p = order?.payment?.find((x) => String(x._id) === String(paymentId));
    if (!p) return null;
    return {
      ...p,
      source: "order",
      orderMongoId: String(order._id),
      paymentId: String(p._id),
      orderId: order.orderId,
      farmerName: order.farmer?.name,
    };
  }

  const order = await AgriSalesOrder.findById(orderMongoId)
    .select("orderNumber payment customerName customerMobile")
    .lean();
  const p = order?.payment?.find((x) => String(x._id) === String(paymentId));
  if (!p) return null;
  return {
    ...p,
    source: "agriSales",
    orderMongoId: String(order._id),
    paymentId: String(p._id),
    orderId: order.orderNumber,
    customerName: order.customerName,
  };
}

function alreadyVerified(pay) {
  if (pay.bankVerificationStatus === "BANK_VERIFIED" || pay.paymentStatus === "BANK_VERIFIED") return true;
  if (pay.paymentStatus === "PENDING") return false;
  return pay.paymentStatus === "COLLECTED";
}

const OPEN_LINES = { reconciliationStatus: { $in: ["UNMATCHED", "SUSPENSE"] } };

/** Open statement lines for this UTR, transaction id or cheque. No date scan. */
async function candidateEntries(pay) {
  const keys = statementLookupKeys(pay);
  if (!keys.length) return [];
  return BankStatementEntry.find({
    ...NOT_STATEMENT_VERIFIED,
    ...OPEN_LINES,
    $or: [
      { referenceNumber: { $in: keys } },
      { utr: { $in: keys } },
      { transactionId: { $in: keys } },
      { chequeNumber: { $in: keys } },
    ],
  })
    .select("utr referenceNumber transactionId chequeNumber amount txnDate narration accountNumber")
    .lean()
    .exec();
}

/**
 * Same UTR but a different amount is the case the accountant most needs to see,
 * and `scoreMatch` deliberately drops it because amount is a hard gate.
 */
async function findUtrAmountMismatch(pay) {
  const keys = statementLookupKeys(pay);
  const utr = normalizeUtr(primaryStatementUtr(pay) || paymentUtr(pay));
  if (!utr || utr.length < 6) return null;

  const entries = await BankStatementEntry.find({
    ...NOT_STATEMENT_VERIFIED,
    ...OPEN_LINES,
    $or: [{ referenceNumber: { $in: keys } }, { utr: { $in: keys } }],
  })
    .select("utr referenceNumber amount narration")
    .lean()
    .exec();

  return (
    entries.find((e) => {
      const ref = normalizeUtr(e.referenceNumber || e.utr || "");
      if (!ref || ref !== utr) return false;
      return Math.abs(normalizeAmount(e.amount) - normalizeAmount(pay.paidAmount)) >= AMOUNT_EPS;
    }) || null
  );
}

/** What an accountant should do next when nothing matched. */
function notFoundMessage(utr, bankConfigured) {
  const which = utr ? `UTR ${utr}` : "this payment";
  return bankConfigured
    ? `${which} is not in the bank statement yet`
    : `No credit for ${which} in the statement. Import the statement covering this date under Bank Recon → Statement.`;
}

/** Score the payment using the clean UTR when the saved field also holds a bank id. */
function paymentForScoring(pay) {
  const clean = primaryStatementUtr(pay);
  if (!clean || clean === paymentUtr(pay)) return pay;
  return { ...pay, utrNumber: clean };
}

/** Score stored statement lines. Returns a result, or null when nothing matched. */
async function matchStoredStatement(pay, { userId, runId, paymentId, utr }) {
  const used = await findConsumedStatementLine(pay);
  if (used && String(used.matchedPaymentId) !== String(pay.paymentId)) {
    return {
      ok: true,
      result: CHECK_RESULT.NOT_FOUND,
      message: `UTR ${utr} is already matched to another payment.`,
      utr,
      bankAmount: used.amount,
    };
  }

  const scoringPay = paymentForScoring(pay);
  const entries = await candidateEntries(scoringPay);
  const candidates = [];
  for (const entry of entries) {
    const match = scoreMatch(scoringPay, entry);
    if (match) candidates.push(match);
  }
  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    return askToConfirm(pay, utr, "Several open bank lines match. Pick the one for this payment.");
  }

  const best = candidates[0];
  if (qualifiesForAutoVerify(best)) {
    const applied = await applyMatch(pay, best, runId, userId);
    if (!applied.ok) {
      if (String(applied.error || "").includes("already matched")) {
        return {
          ok: true,
          result: CHECK_RESULT.NOT_FOUND,
          message: `UTR ${utr} is already matched to another payment.`,
          utr,
        };
      }
      return { ok: false, error: applied.error };
    }
    log().info("Payment verified on demand", { paymentId, rule: best.rule, score: best.score });
    return {
      ok: true,
      result: CHECK_RESULT.VERIFIED,
      message: `UTR ${utr} is in the latest bank statement.`,
      utr,
      score: best.score,
      matchedBy: best.rule,
      bankAmount: best.entry.amount,
      narration: best.entry.narration || "",
    };
  }

  if (best) {
    return askToConfirm(
      pay,
      utr,
      `Found a credit but it ${whyNotAutoVerified(best)}. Pick the bank line.`
    );
  }

  const mismatch = await findUtrAmountMismatch(scoringPay);
  if (mismatch) {
    return askToConfirm(
      pay,
      utr,
      `Bank shows ${mismatch.amount} for this UTR, payment says ${pay.paidAmount}. Pick the line if it is the right one.`
    );
  }

  return null;
}

async function askToConfirm(pay, utr, message) {
  const lines = await listOpenMatches(pay);
  if (!lines.length) return null;
  return {
    ok: true,
    result: CHECK_RESULT.NEEDS_CONFIRMATION,
    message,
    utr,
    candidates: lines,
  };
}

/**
 * Verify one payment against the bank.
 *
 * @param {{ source: "order"|"agriSales", orderMongoId: string, paymentId: string, userId?: string, allowLiveLookup?: boolean }} args
 * @returns {Promise<{ ok: boolean, result?: string, message?: string, error?: string }>}
 */
export async function checkPaymentAgainstBank({
  source,
  orderMongoId,
  paymentId,
  userId = null,
}) {
  if (!["order", "agriSales"].includes(source)) {
    return { ok: false, error: "source must be 'order' or 'agriSales'" };
  }

  const pay = await loadPayment({ source, orderMongoId, paymentId });
  if (!pay) return { ok: false, error: "Payment not found" };

  if (alreadyVerified(pay)) {
    return {
      ok: true,
      result: CHECK_RESULT.VERIFIED,
      alreadyVerified: true,
      message: "Payment was already verified by bank",
      utr: paymentUtr(pay),
      bankAmount: pay.bankAmount ?? null,
      narration: pay.bankNarration || "",
    };
  }

  const utr = paymentUtr(pay);
  if (!utr && !pay.chequeNumber) {
    return { ok: false, error: "Payment has no UTR, transaction id or cheque number" };
  }

  const runId = crypto.randomUUID();
  const stored = await matchStoredStatement(pay, { userId, runId, paymentId, utr });
  if (stored) return stored;

  const lines = await listOpenMatches(pay);
  if (lines.length) {
    return {
      ok: true,
      result: CHECK_RESULT.NEEDS_CONFIRMATION,
      message: "No exact UTR match. These open bank lines share the reference or the amount.",
      utr,
      candidates: lines,
    };
  }

  return {
    ok: true,
    result: CHECK_RESULT.NOT_FOUND,
    message: notFoundMessage(utr, false),
    utr,
  };
}
