/**
 * Enhanced reconciliation engine with confidence scoring.
 *
 * Match priority (highest confidence first):
 *   1. UTR + amount + account + date        → 100 (EXACT)
 *   2. UTR + amount                          → 95
 *   3. transaction id + amount               → 90
 *   4. cheque + amount                       → 85
 *   5. amount + date (±2 days) + narration   → 60–80 (FUZZY)
 *
 * Flow:
 *   PENDING → BANK_VERIFIED (score >= threshold)
 *   PENDING → SUSPENSE (no match / low score / multiple matches)
 */

import crypto from "crypto";
import Order from "../../../models/order.model.js";
import AgriSalesOrder from "../../../models/agriSalesOrder.model.js";
import BankStatementEntry from "../../../models/bankStatementEntry.model.js";
import BankReconciliationMatch from "../../finance/ledger/models/bankReconciliationMatch.model.js";
import PaymentReconciliation from "../models/paymentReconciliation.model.js";
import CashBook from "../models/cashBook.model.js";
import { normalizeUtr, normalizeAmount } from "../../../services/iciciBankService.js";
import { collectPendingBankReconciliationPayments } from "../../../services/reconciliation.service.js";
import { narrationSimilarity, containsUtrInNarration } from "../utils/narrationSimilarity.js";
import { routeToSuspense } from "./suspense.service.js";
import { transitionPaymentStatus } from "./verificationStatusEngine.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

const AMOUNT_EPS = 0.02;
const DATE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const AUTO_VERIFY_THRESHOLD = Number(process.env.BANKING_AUTO_VERIFY_THRESHOLD || 85);
const FUZZY_THRESHOLD = Number(process.env.BANKING_FUZZY_THRESHOLD || 60);

function getPaymentUtr(p) {
  return (
    (p.utrNumber && String(p.utrNumber).trim()) ||
    (p.transactionId && String(p.transactionId).trim()) ||
    (p.qrReferenceId && String(p.qrReferenceId).trim()) ||
    ""
  );
}

function scoreMatch(payment, entry) {
  const amt = normalizeAmount(payment.paidAmount);
  const eAmt = normalizeAmount(entry.amount);
  if (Math.abs(amt - eAmt) >= AMOUNT_EPS) return null;

  const payDate = new Date(payment.paymentDate);
  const eDate = new Date(entry.txnDate);
  const utr = normalizeUtr(getPaymentUtr(payment));
  const refN = normalizeUtr(entry.referenceNumber || entry.utr || "");
  const txnId = payment.transactionId ? String(payment.transactionId).trim() : "";
  const eTxn = entry.transactionId ? String(entry.transactionId).trim() : "";
  const chq = payment.chequeNumber ? String(payment.chequeNumber).trim() : "";
  const eChq = entry.chequeNumber ? String(entry.chequeNumber).trim() : "";
  const acct = entry.accountNumber || "";
  const payAcct = payment.accountNumber || "";

  let score = 0;
  let rule = "";
  let matchType = "FUZZY";

  if (utr && refN && utr === refN) {
    score = 95;
    rule = "UTR_AMOUNT";
    matchType = "EXACT";
    if (Math.abs(eDate - payDate) <= DATE_WINDOW_MS) {
      score += 3;
      rule = "UTR_AMOUNT_DATE";
    }
    if (payAcct && acct && payAcct === acct) {
      score = 100;
      rule = "UTR_AMOUNT_ACCOUNT_DATE";
    }
  } else if (txnId && eTxn && txnId === eTxn) {
    score = 90;
    rule = "TXN_ID_AMOUNT";
    matchType = "EXACT";
  } else if (chq && eChq && chq === eChq) {
    score = 85;
    rule = "CHEQUE_AMOUNT";
    matchType = "EXACT";
  } else if (Math.abs(eDate - payDate) <= DATE_WINDOW_MS) {
    score = 65;
    rule = "AMOUNT_DATE";
    matchType = "FUZZY";
    const refText = [payment.farmerName, payment.customerName, payment.orderId, utr]
      .filter(Boolean)
      .join(" ");
    const sim = narrationSimilarity(entry.narration, refText);
    score += Math.round(sim * 15);
    if (containsUtrInNarration(entry.narration, utr)) {
      score += 10;
      rule = "AMOUNT_DATE_NARRATION_UTR";
    } else if (sim > 0.3) {
      rule = "AMOUNT_DATE_NARRATION";
    }
  }

  if (score < FUZZY_THRESHOLD) return null;
  return { score: Math.min(score, 100), rule, matchType, entry };
}

async function applyMatch(pay, match, runId, userId) {
  const { entry, score, rule, matchType } = match;

  const result = await transitionPaymentStatus({
    pay,
    targetStatus: "BANK_VERIFIED",
    bankEntry: entry,
    matchedBy: rule,
    source: matchType === "EXACT" ? "STATEMENT_API" : "STATEMENT_API",
  });

  if (!result.ok) return { ok: false, error: result.error };

  await BankStatementEntry.updateOne(
    { _id: entry._id },
    {
      reconciliationStatus: "MATCHED",
      matchedPaymentId: pay.paymentId,
    }
  );

  await PaymentReconciliation.findOneAndUpdate(
    { paymentId: pay.paymentId, bankTransactionId: entry._id },
    {
      paymentId: pay.paymentId,
      orderMongoId: pay.orderMongoId,
      orderId: pay.orderId,
      source: pay.source,
      bankTransactionId: entry._id,
      matchType,
      matchRule: rule,
      confidenceScore: score,
      previousStatus: "PENDING",
      newStatus: "BANK_VERIFIED",
      utr: getPaymentUtr(pay),
      amount: pay.paidAmount,
      accountNumber: entry.accountNumber,
      txnDate: entry.txnDate,
      narration: entry.narration,
      runId,
      resolvedBy: userId || null,
    },
    { upsert: true, new: true }
  );

  await BankReconciliationMatch.findOneAndUpdate(
    { statementLineId: entry._id },
    {
      statementLineId: entry._id,
      paymentId: pay.paymentId,
      orderMongoId: pay.orderMongoId,
      source: pay.source,
      matchRule: rule,
      matchScore: score,
      matchedBy: userId || null,
    },
    { upsert: true, new: true }
  );

  await CashBook.create({
    entryDate: entry.txnDate,
    entryType: "BANK_CREDIT",
    amount: entry.amount,
    balanceAfter: entry.balance,
    reference: entry.referenceNumber,
    utr: entry.utr || entry.referenceNumber,
    accountNumber: entry.accountNumber,
    narration: entry.narration,
    paymentId: pay.paymentId,
    orderMongoId: pay.orderMongoId,
    bankTransactionId: entry._id,
    createdBy: userId || null,
  });

  return { ok: true, score, rule, matchType };
}

/**
 * Run enhanced reconciliation with confidence scoring.
 */
export async function runEnhancedReconciliation(dateFrom, dateTo, options = {}) {
  const { source = "all", userId = null, runId = crypto.randomUUID() } = options;
  const errors = [];
  const matched = [];
  const suspense = [];
  let updatedCount = 0;

  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  to.setHours(23, 59, 59, 999);

  const entries = await BankStatementEntry.find({
    txnDate: { $gte: from, $lte: to },
    reconciliationStatus: { $in: ["UNMATCHED", "SUSPENSE"] },
  })
    .lean()
    .exec();

  if (!entries.length) {
    return {
      runId,
      matched,
      updatedCount,
      suspense,
      errors,
      message: "No unmatched bank entries in range",
    };
  }

  const pending = await collectPendingBankReconciliationPayments(dateFrom, dateTo);
  const filtered =
    source === "all"
      ? pending
      : pending.filter((p) => (source === "order" ? p.source === "order" : p.source === "agriSales"));

  const usedEntryIds = new Set();

  for (const pay of filtered) {
    const available = entries.filter((e) => e._id && !usedEntryIds.has(String(e._id)));
    const candidates = [];

    for (const e of available) {
      const m = scoreMatch(pay, e);
      if (m) candidates.push(m);
    }

    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      continue;
    }

    if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
      await routeToSuspense({
        payment: pay,
        reason: "MULTIPLE_MATCH",
        candidates: candidates.slice(0, 3),
        runId,
      });
      suspense.push({ paymentId: pay.paymentId, reason: "MULTIPLE_MATCH" });
      errors.push({ paymentId: pay.paymentId, message: "Multiple equal-confidence matches" });
      continue;
    }

    const best = candidates[0];
    if (best.score < AUTO_VERIFY_THRESHOLD) {
      await routeToSuspense({
        payment: pay,
        bankEntry: best.entry,
        reason: "MANUAL_REVIEW",
        confidenceScore: best.score,
        runId,
      });
      suspense.push({ paymentId: pay.paymentId, reason: "LOW_CONFIDENCE", score: best.score });
      continue;
    }

    try {
      const result = await applyMatch(pay, best, runId, userId);
      if (result.ok) {
        if (best.entry._id) usedEntryIds.add(String(best.entry._id));
        updatedCount += 1;
        matched.push({
          source: pay.source,
          orderId: pay.orderId,
          paymentId: pay.paymentId,
          paidAmount: pay.paidAmount,
          matchedBy: best.rule,
          confidenceScore: best.score,
          matchType: best.matchType,
        });
      } else {
        errors.push({ paymentId: pay.paymentId, message: result.error });
      }
    } catch (err) {
      errors.push({ paymentId: pay.paymentId, message: err.message });
    }
  }

  // Orphan bank credits → suspense
  for (const e of entries) {
    if (usedEntryIds.has(String(e._id))) continue;
    if (e.amount <= 0) continue;
    const already = await routeToSuspense({
      bankEntry: e,
      reason: "ORPHAN_CREDIT",
      runId,
    });
    if (already?.created) {
      suspense.push({ bankTransactionId: String(e._id), reason: "ORPHAN_CREDIT" });
    }
  }

  log().info("Reconciliation run complete", {
    runId,
    matched: matched.length,
    suspense: suspense.length,
    errors: errors.length,
  });

  return { runId, matched, updatedCount, suspense, errors };
}

export { scoreMatch, AUTO_VERIFY_THRESHOLD, FUZZY_THRESHOLD };
