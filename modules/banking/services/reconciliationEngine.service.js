/**
 * Reconciliation engine with confidence scoring.
 *
 * Amount is a hard gate everywhere: a pair whose amounts differ by a paisa or
 * more is never a candidate, however well everything else lines up.
 *
 * Match priority (highest confidence first):
 *   1. UTR + amount + account + date        → 100 (EXACT)
 *   2. UTR + amount + date                   → 98
 *   3. UTR + amount                          → 95
 *   4. transaction id + amount               → 90
 *   5. cheque + amount                       → 85
 *   6. amount + date (±2 days) + narration   → 60–80 (FUZZY)
 *
 * Only 1–3 may clear a payment on their own — see `qualifiesForAutoVerify`.
 * Everything else is a suggestion for an accountant, not a decision.
 *
 * Flow:
 *   PENDING → BANK_VERIFIED (UTR and amount agree with the bank)
 *   PENDING → SUSPENSE      (anything else: no match, no UTR match, or a tie)
 *   SUSPENSE → BANK_VERIFIED (a later run finds the UTR line; the row closes itself)
 */

import crypto from "crypto";
import Order from "../../../models/order.model.js";
import AgriSalesOrder from "../../../models/agriSalesOrder.model.js";
import BankStatementEntry, {
  NOT_STATEMENT_VERIFIED,
} from "../../../models/bankStatementEntry.model.js";
import BankReconciliationMatch from "../../finance/ledger/models/bankReconciliationMatch.model.js";
import PaymentReconciliation from "../models/paymentReconciliation.model.js";
import CashBook from "../models/cashBook.model.js";
import { normalizeUtr, normalizeAmount } from "../../../services/iciciBankService.js";
import { collectPendingBankReconciliationPayments } from "../../../services/reconciliation.service.js";
import { narrationSimilarity, containsUtrInNarration } from "../utils/narrationSimilarity.js";
import { routeToSuspense, closeOpenSuspenseFor } from "./suspense.service.js";
import { transitionPaymentStatus } from "./verificationStatusEngine.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

const AMOUNT_EPS = 0.02;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_WINDOW_MS = 2 * DAY_MS;
/** Scores below this are not even offered as a candidate. */
const FUZZY_THRESHOLD = Number(process.env.BANKING_FUZZY_THRESHOLD || 60);
/** Statement lines this far either side of the run's range can still match. */
const SEARCH_WINDOW_DAYS = 7;
const HOUR_MS = 60 * 60 * 1000;
/**
 * Hours an ERP payment or a bank credit may stay unmatched before it goes to
 * suspense (NO_MATCH / ORPHAN_CREDIT). Until then it waits for its other half.
 */
const SUSPENSE_AFTER_HOURS = Number(
  process.env.BANKING_SUSPENSE_AFTER_HOURS ||
    (process.env.BANKING_NO_MATCH_GRACE_DAYS ? Number(process.env.BANKING_NO_MATCH_GRACE_DAYS) * 24 : 24)
);
const NO_MATCH_GRACE_DAYS = SUSPENSE_AFTER_HOURS / 24;

const IST_OFFSET_MS = 330 * 60 * 1000;
const indiaDay = (d) => new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

const validDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** A payment waits from its payment date; a bank line from its transaction date. */
export function paymentUnmatchedSince(payment) {
  return validDate(payment?.paymentDate);
}

export function lineUnmatchedSince(entry) {
  return validDate(entry?.txnDate);
}

export function hasWaitedLongEnough(since, now = new Date(), hours = SUSPENSE_AFTER_HOURS) {
  if (!since) return false;
  return now.getTime() - since.getTime() >= hours * HOUR_MS;
}

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

/**
 * Auto-verification policy: a payment may only clear itself when the bank
 * agrees on both the UTR and the amount. Nothing else is certain enough.
 *
 * Everything the scorer can still produce — a cheque number, a bank transaction
 * id, or an amount-and-date guess — goes to suspense for an accountant to
 * confirm, however high it scored. Amount is already a hard gate inside
 * `scoreMatch`, so a UTR rule here implies the amount agreed.
 *
 * @param {{ rule: string, matchType: string }|null|undefined} match
 * @returns {boolean}
 */
export function qualifiesForAutoVerify(match) {
  if (!match) return false;
  return match.matchType === "EXACT" && String(match.rule || "").startsWith("UTR");
}

/**
 * A line carrying the payment's UTR at a different amount. `scoreMatch` drops
 * these because amount is a hard gate, but it is the case an accountant most
 * needs to see.
 *
 * @returns {object|null}
 */
export function findUtrAmountMismatchIn(payment, entries) {
  const utr = normalizeUtr(getPaymentUtr(payment));
  if (!utr || utr.length < 6) return null;
  const amt = normalizeAmount(payment.paidAmount);
  return (
    (entries || []).find((e) => {
      const ref = normalizeUtr(e.referenceNumber || e.utr || "");
      return ref === utr && Math.abs(normalizeAmount(e.amount) - amt) >= AMOUNT_EPS;
    }) || null
  );
}

/** Whether a payment with no bank line has waited long enough to be reported. */
export function isPastNoMatchGrace(payment, now = new Date(), graceDays = NO_MATCH_GRACE_DAYS) {
  return hasWaitedLongEnough(paymentUnmatchedSince(payment), now, graceDays * 24);
}

/** References that identify one bank line on their own, whatever its date. */
function lookupKeys(payment) {
  const raw = [getPaymentUtr(payment), payment.transactionId, payment.chequeNumber]
    .map((v) => (v == null ? "" : String(v).trim()))
    .filter((v) => v.length >= 6);
  return [...new Set([...raw, ...raw.map((k) => normalizeUtr(k)).filter(Boolean)])];
}

/**
 * Open statement lines a run should score: the run's range widened by
 * SEARCH_WINDOW_DAYS, plus any line carrying one of the payments' references.
 * Without the widening a payment keyed on the 31st whose credit lands on the
 * 1st never meets its line.
 */
async function loadCandidateEntries(from, to, payments) {
  const windowFrom = new Date(from.getTime() - SEARCH_WINDOW_DAYS * DAY_MS);
  const windowTo = new Date(to.getTime() + SEARCH_WINDOW_DAYS * DAY_MS);

  const windowed = await BankStatementEntry.find({
    txnDate: { $gte: windowFrom, $lte: windowTo },
    reconciliationStatus: { $in: ["UNMATCHED", "SUSPENSE"] },
    ...NOT_STATEMENT_VERIFIED,
  })
    .lean()
    .exec();

  const keys = [...new Set(payments.flatMap(lookupKeys))];
  const byKey = keys.length
    ? await BankStatementEntry.find({
        reconciliationStatus: { $in: ["UNMATCHED", "SUSPENSE"] },
        ...NOT_STATEMENT_VERIFIED,
        $or: [
          { referenceNumber: { $in: keys } },
          { utr: { $in: keys } },
          { transactionId: { $in: keys } },
          { chequeNumber: { $in: keys } },
        ],
      })
        .lean()
        .exec()
    : [];

  const seen = new Set();
  return [...windowed, ...byKey].filter((e) => {
    const id = String(e._id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
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

  await closeOpenSuspenseFor({
    paymentId: pay.paymentId,
    bankTransactionId: entry._id,
    note: `Matched automatically on ${rule}${runId ? ` (run ${runId})` : ""}`,
  });

  return { ok: true, score, rule, matchType };
}

/**
 * Run enhanced reconciliation with confidence scoring.
 */
export async function runEnhancedReconciliation(dateFrom, dateTo, options = {}) {
  const { source = "all", userId = null, runId = crypto.randomUUID(), now = new Date() } = options;
  const errors = [];
  const matched = [];
  const suspense = [];
  const waiting = { payments: 0, lines: 0, noStatementYet: 0 };
  let updatedCount = 0;

  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  to.setHours(23, 59, 59, 999);

  // With no statement for the range at all, every payment would look missing
  // from the bank. Only report NO_MATCH once there is a statement to compare to.
  const statementLines = await BankStatementEntry.countDocuments({
    txnDate: { $gte: from, $lte: to },
  });
  if (!statementLines) {
    return {
      runId,
      matched,
      updatedCount,
      suspense,
      errors,
      waiting,
      message: "No bank statement lines in range. Sync or import the statement first.",
    };
  }

  // A payment is only "missing from the bank" once the statement reaches its day.
  const latestLine = await BankStatementEntry.findOne({}).sort({ txnDate: -1 }).select("txnDate").lean();
  const statementThrough = latestLine ? indiaDay(latestLine.txnDate) : "";

  const pending = await collectPendingBankReconciliationPayments(from, to, {
    includeSuspense: true,
  });
  const filtered =
    source === "all"
      ? pending
      : pending.filter((p) => (source === "order" ? p.source === "order" : p.source === "agriSales"));

  const entries = await loadCandidateEntries(from, to, filtered);

  const usedEntryIds = new Set();
  /** Lines offered to a payment in this run; not orphan credits. */
  const claimedEntryIds = new Set();
  const claim = (routed, entry) => {
    if (!routed?.decided && entry?._id) claimedEntryIds.add(String(entry._id));
  };

  for (const pay of filtered) {
    const available = entries.filter((e) => e._id && !usedEntryIds.has(String(e._id)));
    const candidates = [];

    for (const e of available) {
      const m = scoreMatch(pay, e);
      if (m) candidates.push(m);
    }

    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      const mismatch = findUtrAmountMismatchIn(pay, available);
      if (mismatch) {
        const routed = await routeToSuspense({
          payment: pay,
          bankEntry: mismatch,
          reason: "AMOUNT_MISMATCH",
          runId,
        });
        claim(routed, mismatch);
        if (routed.created) {
          suspense.push({ paymentId: pay.paymentId, reason: "AMOUNT_MISMATCH" });
        }
      } else if (!isPastNoMatchGrace(pay, now)) {
        waiting.payments += 1;
      } else if (!statementThrough || statementThrough < indiaDay(paymentUnmatchedSince(pay))) {
        waiting.noStatementYet += 1;
      } else {
        const routed = await routeToSuspense({ payment: pay, reason: "NO_MATCH", runId });
        if (routed.created) suspense.push({ paymentId: pay.paymentId, reason: "NO_MATCH" });
      }
      continue;
    }

    if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
      const tied = candidates.filter((c) => c.score === candidates[0].score);
      const routed = await routeToSuspense({
        payment: pay,
        reason: "MULTIPLE_MATCH",
        candidates: tied.slice(0, 3),
        runId,
      });
      for (const c of tied) claim(routed, c.entry);
      if (routed.created) suspense.push({ paymentId: pay.paymentId, reason: "MULTIPLE_MATCH" });
      errors.push({ paymentId: pay.paymentId, message: "Multiple equal-confidence matches" });
      continue;
    }

    const best = candidates[0];
    if (!qualifiesForAutoVerify(best)) {
      const routed = await routeToSuspense({
        payment: pay,
        bankEntry: best.entry,
        reason: "MANUAL_REVIEW",
        confidenceScore: best.score,
        runId,
      });
      claim(routed, best.entry);
      if (routed.created) {
        suspense.push({
          paymentId: pay.paymentId,
          reason: "MANUAL_REVIEW",
          rule: best.rule,
          score: best.score,
        });
      }
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

  // Orphan bank credits → suspense. Lines outside the run's own range were only
  // loaded so payments could reach them; their own run reports them.
  for (const e of entries) {
    const id = String(e._id);
    if (usedEntryIds.has(id) || claimedEntryIds.has(id)) continue;
    if (e.amount <= 0) continue;
    const when = new Date(e.txnDate);
    if (when < from || when > to) continue;
    if (e.reconciliationStatus !== "SUSPENSE" && !hasWaitedLongEnough(lineUnmatchedSince(e), now)) {
      waiting.lines += 1;
      continue;
    }
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
    waiting,
  });

  const notes = [
    `${updatedCount} payment${updatedCount === 1 ? "" : "s"} verified by bank`,
    `${suspense.length} sent to suspense`,
  ];
  const under = waiting.payments + waiting.lines;
  if (under) {
    notes.push(
      `${under} still unmatched for less than ${SUSPENSE_AFTER_HOURS} hours (${waiting.payments} payment${
        waiting.payments === 1 ? "" : "s"
      }, ${waiting.lines} bank line${waiting.lines === 1 ? "" : "s"}) — they go to suspense if still unmatched after that`
    );
  }
  if (waiting.noStatementYet) {
    notes.push(`${waiting.noStatementYet} payment(s) wait for the statement to reach their date`);
  }

  return { runId, matched, updatedCount, suspense, errors, waiting, message: `${notes.join("; ")}.` };
}

export {
  scoreMatch,
  applyMatch,
  FUZZY_THRESHOLD,
  NO_MATCH_GRACE_DAYS,
  SUSPENSE_AFTER_HOURS,
  SEARCH_WINDOW_DAYS,
};
