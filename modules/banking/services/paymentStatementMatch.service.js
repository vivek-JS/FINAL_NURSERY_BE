/**
 * After a payment is saved, pull the latest ICICI statement and say whether
 * its UTR is already on that statement. A bank failure must not undo the payment.
 */

import { refreshRecentCorporateStatement } from "./statementRefresh.service.js";
import { checkPaymentAgainstBank, CHECK_RESULT } from "./paymentBankCheck.service.js";

function referenceOf(payment) {
  return String(payment?.utrNumber || payment?.transactionId || payment?.chequeNumber || "").trim();
}

function referenceLabel(payment, reference) {
  const hasUtr = String(payment?.utrNumber || payment?.transactionId || "").trim();
  return hasUtr ? `UTR ${reference}` : `Cheque ${reference}`;
}

function shouldCheck(payment) {
  if (!payment || payment.isWalletPayment || payment.isDiscount) return false;
  const mode = String(payment.modeOfPayment || "").toLowerCase();
  if (mode === "cash" || mode === "wallet") return false;
  return Boolean(referenceOf(payment));
}

function sentence(outcome, label) {
  switch (outcome?.result) {
    case CHECK_RESULT.VERIFIED:
      return `${label} is in the latest bank statement.`;
    case CHECK_RESULT.AMOUNT_MISMATCH:
      return outcome.message || `${label} is in the statement but the amount does not match.`;
    case CHECK_RESULT.NOT_FOUND:
      return `${label} is not in the latest bank statement.`;
    case CHECK_RESULT.MULTIPLE_MATCH:
    case CHECK_RESULT.NEEDS_REVIEW:
      return outcome.message || `${label} matched more than one statement line.`;
    default:
      return outcome?.error || outcome?.message || `${label} could not be checked against the statement.`;
  }
}

/**
 * Fetch a short recent statement window, then match each payment that has a UTR.
 * @param {object[]} payments
 * @param {{ userId?: string }} [options]
 */
export async function checkNewPaymentsAgainstStatement(payments, { userId } = {}) {
  const targets = (payments || []).filter(shouldCheck);
  if (!targets.length) return { checked: false, results: [], message: null };

  let earliest = null;
  for (const payment of targets) {
    const dated = new Date(payment.paymentDate || Date.now());
    if (!Number.isNaN(dated.getTime()) && (!earliest || dated < earliest)) earliest = dated;
  }

  let fetchError = null;
  try {
    await refreshRecentCorporateStatement(userId || null, { fromDate: earliest });
  } catch (err) {
    fetchError = err.message || "ICICI statement request failed";
  }

  const results = [];
  for (const payment of targets) {
    const reference = referenceOf(payment);
    const label = referenceLabel(payment, reference);
    try {
      const outcome = await checkPaymentAgainstBank({
        source: payment.source,
        orderMongoId: payment.orderMongoId,
        paymentId: payment.paymentId,
        userId: userId || null,
        allowLiveLookup: false,
      });
      let message = sentence(outcome, label);
      if (fetchError && outcome?.result === CHECK_RESULT.NOT_FOUND) {
        message = `Could not refresh the bank statement (${fetchError}). ${message}`;
      }
      results.push({ paymentId: String(payment.paymentId), utr: reference, ...outcome, message });
    } catch (err) {
      results.push({
        paymentId: String(payment.paymentId),
        utr: reference,
        ok: false,
        message: `Could not check ${label} against the statement.`,
      });
    }
  }

  return {
    checked: true,
    fetchError,
    results,
    message: results.map((row) => row.message).filter(Boolean).join(" "),
  };
}

export function appendBankStatementMessage(base, check) {
  const extra = check?.message;
  if (!extra) return base;
  return `${base}. ${extra}`;
}
