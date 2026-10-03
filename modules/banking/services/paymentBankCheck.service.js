/**
 * On-demand bank check for a single payment.
 *
 * The batch engine walks every pending payment on a schedule; this runs the same
 * matching for one payment the moment an accountant asks, using the UTR and amount
 * the receipt OCR already captured.
 *
 * Order of attempts:
 *   1. Stored statement lines (same scoring as the batch engine)
 *   2. ICICI Transaction Inquiry, when no line has landed yet
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
import { routeToSuspense } from "./suspense.service.js";
import { transitionPaymentStatus } from "./verificationStatusEngine.js";
import { fetchTransactionStatus } from "./iciciCorporateStatus.service.js";
import { normalizeAmount, normalizeUtr } from "../../../services/iciciBankService.js";
import { getIciciCorporateConfig } from "../config/iciciCorporate.config.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

const AMOUNT_EPS = 0.02;
/** How far either side of the payment date we look for a statement line. */
const SEARCH_WINDOW_DAYS = 7;

export const CHECK_RESULT = {
  VERIFIED: "VERIFIED",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  MULTIPLE_MATCH: "MULTIPLE_MATCH",
  /** A credit was found but not on a UTR, so an accountant must confirm it. */
  NEEDS_REVIEW: "NEEDS_REVIEW",
  NOT_FOUND: "NOT_FOUND",
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
  return (
    pay.bankVerificationStatus === "BANK_VERIFIED" ||
    pay.paymentStatus === "BANK_VERIFIED" ||
    pay.paymentStatus === "COLLECTED"
  );
}

/** Statement lines worth scoring against this payment. */
async function candidateEntries(pay) {
  const centre = new Date(pay.paymentDate || Date.now());
  const from = new Date(centre);
  from.setDate(from.getDate() - SEARCH_WINDOW_DAYS);
  const to = new Date(centre);
  to.setDate(to.getDate() + SEARCH_WINDOW_DAYS);
  to.setHours(23, 59, 59, 999);

  return BankStatementEntry.find({
    txnDate: { $gte: from, $lte: to },
    reconciliationStatus: { $in: ["UNMATCHED", "SUSPENSE"] },
    ...NOT_STATEMENT_VERIFIED,
  })
    .lean()
    .exec();
}

/**
 * Same UTR but a different amount is the case the accountant most needs to see,
 * and `scoreMatch` deliberately drops it because amount is a hard gate.
 */
async function findUtrAmountMismatch(pay) {
  const utr = normalizeUtr(paymentUtr(pay));
  if (!utr || utr.length < 6) return null;

  const entries = await BankStatementEntry.find({
    reconciliationStatus: { $in: ["UNMATCHED", "SUSPENSE"] },
    ...NOT_STATEMENT_VERIFIED,
  })
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

function liveStatusIsSuccess(status) {
  return ["SUCCESS", "COMPLETED", "SETTLED", "PAID"].includes(
    String(status || "").toUpperCase()
  );
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
  allowLiveLookup = true,
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

  // 1. Stored statement lines.
  const entries = await candidateEntries(pay);
  const candidates = [];
  for (const e of entries) {
    const m = scoreMatch(pay, e);
    if (m) candidates.push(m);
  }
  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    await routeToSuspense({
      payment: pay,
      reason: "MULTIPLE_MATCH",
      candidates: candidates.slice(0, 3),
      runId,
    });
    return {
      ok: true,
      result: CHECK_RESULT.MULTIPLE_MATCH,
      message: `${candidates.length} bank lines match equally — sent to suspense`,
      utr,
      score: candidates[0].score,
    };
  }

  const best = candidates[0];
  if (qualifiesForAutoVerify(best)) {
    const applied = await applyMatch(pay, best, runId, userId);
    if (!applied.ok) return { ok: false, error: applied.error };
    log().info("Payment verified on demand", { paymentId, rule: best.rule, score: best.score });
    return {
      ok: true,
      result: CHECK_RESULT.VERIFIED,
      message: `Matched bank statement (${best.rule})`,
      utr,
      score: best.score,
      matchedBy: best.rule,
      bankAmount: best.entry.amount,
      narration: best.entry.narration || "",
    };
  }

  if (best) {
    await routeToSuspense({
      payment: pay,
      bankEntry: best.entry,
      reason: "MANUAL_REVIEW",
      confidenceScore: best.score,
      runId,
    });
    return {
      ok: true,
      result: CHECK_RESULT.NEEDS_REVIEW,
      message: `Found a credit but it ${whyNotAutoVerified(best)} — sent to suspense for confirmation`,
      utr,
      score: best.score,
      matchedBy: best.rule,
      bankAmount: best.entry.amount,
      narration: best.entry.narration || "",
    };
  }

  // 2. Same UTR, different amount — suspense rather than a silent miss.
  const mismatch = await findUtrAmountMismatch(pay);
  if (mismatch) {
    await routeToSuspense({
      payment: pay,
      bankEntry: mismatch,
      reason: "AMOUNT_MISMATCH",
      runId,
    });
    return {
      ok: true,
      result: CHECK_RESULT.AMOUNT_MISMATCH,
      message: `Bank shows ${mismatch.amount} for this UTR, payment says ${pay.paidAmount}`,
      utr,
      bankAmount: mismatch.amount,
      narration: mismatch.narration || "",
    };
  }

  // 3. Nothing stored yet — ask the bank directly.
  if (allowLiveLookup) {
    try {
      const live = await fetchTransactionStatus({
        utr,
        merchantTranId: pay.merchantTranId,
        amount: pay.paidAmount,
        userId,
      });

      if (liveStatusIsSuccess(live.status)) {
        const liveAmount = normalizeAmount(live.amount ?? pay.paidAmount);
        const sameAmount =
          Math.abs(liveAmount - normalizeAmount(pay.paidAmount)) < AMOUNT_EPS;

        if (!sameAmount) {
          await routeToSuspense({ payment: pay, reason: "AMOUNT_MISMATCH", runId });
          return {
            ok: true,
            result: CHECK_RESULT.AMOUNT_MISMATCH,
            message: `Bank shows ${liveAmount} for this UTR, payment says ${pay.paidAmount}`,
            utr,
            bankAmount: liveAmount,
          };
        }

        const cfg = getIciciCorporateConfig();
        const transition = await transitionPaymentStatus({
          pay,
          targetStatus: "BANK_VERIFIED",
          bankEntry: {
            referenceNumber: live.utr || utr,
            narration: "Verified via ICICI Transaction Inquiry",
            amount: liveAmount,
            txnDate: new Date(live.verifiedAt || Date.now()),
            accountNumber: cfg.accountNumber,
            rawResponse: live.raw || live,
          },
          matchedBy: "UTR",
          source: "TXN_STATUS_API",
        });
        if (!transition.ok) return { ok: false, error: transition.error };

        log().info("Payment verified via transaction inquiry", { paymentId, utr });
        return {
          ok: true,
          result: CHECK_RESULT.VERIFIED,
          message: "Verified directly with ICICI (no statement line yet)",
          utr,
          matchedBy: "UTR",
          bankAmount: liveAmount,
        };
      }
    } catch (err) {
      // A bank outage must not look like "this UTR does not exist".
      log().warn("Transaction inquiry failed during payment check", {
        paymentId,
        error: err.message,
      });
      return {
        ok: false,
        error: `Could not reach ICICI: ${err.message}`,
        code: "ICICI_UNREACHABLE",
      };
    }
  }

  return {
    ok: true,
    result: CHECK_RESULT.NOT_FOUND,
    message: "This UTR is not in the bank statement yet",
    utr,
  };
}
