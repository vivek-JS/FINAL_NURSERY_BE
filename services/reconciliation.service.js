/**
 * ERP bank reconciliation — match Order / Agri payment rows to BankStatementEntry lines.
 * Priority: UTR → transaction id → cheque → amount + date (within 2 days).
 */

import Order from "../models/order.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import { normalizeUtr, normalizeAmount } from "./iciciBankService.js";
import { getStoredEntriesForRange } from "./iciciStatement.service.js";

const AMOUNT_EPS = 0.02;
const DATE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

function paymentNeedsBankVerification(p) {
  if (p.paymentStatus !== "PENDING") return false;
  const b = p.bankVerificationStatus;
  if (!b || b === "PENDING") return true;
  return false;
}

function getPaymentUtr(p) {
  return (
    (p.utrNumber && String(p.utrNumber).trim()) ||
    (p.transactionId && String(p.transactionId).trim()) ||
    (p.qrReferenceId && String(p.qrReferenceId).trim()) ||
    ""
  );
}

/**
 * Find all uncleared payments that need bank reconciliation.
 */
export async function collectPendingBankReconciliationPayments(dateFrom, dateTo) {
  const list = [];
  const now = new Date();

  const qOrder = { "payment.paymentStatus": "PENDING" };
  if (dateFrom || dateTo) {
    qOrder["payment.paymentDate"] = {};
    if (dateFrom) qOrder["payment.paymentDate"].$gte = new Date(dateFrom);
    if (dateTo) qOrder["payment.paymentDate"].$lte = new Date(dateTo);
  }

  const orders = await Order.find(qOrder)
    .select("orderId payment farmer")
    .populate("farmer", "name village")
    .lean();

  for (const order of orders) {
    for (const p of order.payment || []) {
      if (!paymentNeedsBankVerification(p)) continue;
      if (p.qrExpiresAt && new Date(p.qrExpiresAt) < now) continue;
      const hasRef =
        getPaymentUtr(p) ||
        (p.chequeNumber && String(p.chequeNumber).trim()) ||
        (p.merchantTranId && String(p.merchantTranId).trim());
      if (!hasRef) continue;
      list.push({
        source: "order",
        orderMongoId: order._id.toString(),
        paymentId: p._id.toString(),
        orderId: order.orderId,
        paidAmount: p.paidAmount,
        paymentDate: p.paymentDate,
        modeOfPayment: p.modeOfPayment,
        transactionId: p.transactionId,
        utrNumber: p.utrNumber,
        chequeNumber: p.chequeNumber,
        qrReferenceId: p.qrReferenceId,
        merchantTranId: p.merchantTranId,
        farmerName: order.farmer?.name,
      });
    }
  }

  const qAgri = { "payment.paymentStatus": "PENDING" };
  if (dateFrom || dateTo) {
    qAgri["payment.paymentDate"] = {};
    if (dateFrom) qAgri["payment.paymentDate"].$gte = new Date(dateFrom);
    if (dateTo) qAgri["payment.paymentDate"].$lte = new Date(dateTo);
  }

  const agriOrders = await AgriSalesOrder.find(qAgri)
    .select("orderNumber payment customerName customerMobile")
    .lean();

  for (const order of agriOrders) {
    for (const p of order.payment || []) {
      if (!paymentNeedsBankVerification(p)) continue;
      if (p.qrExpiresAt && new Date(p.qrExpiresAt) < now) continue;
      const hasRef =
        getPaymentUtr(p) ||
        (p.chequeNumber && String(p.chequeNumber).trim()) ||
        (p.merchantTranId && String(p.merchantTranId).trim());
      if (!hasRef) continue;
      list.push({
        source: "agriSales",
        orderMongoId: order._id.toString(),
        paymentId: p._id.toString(),
        orderId: order.orderNumber,
        paidAmount: p.paidAmount,
        paymentDate: p.paymentDate,
        modeOfPayment: p.modeOfPayment,
        transactionId: p.transactionId,
        utrNumber: p.utrNumber,
        chequeNumber: p.chequeNumber,
        qrReferenceId: p.qrReferenceId,
        merchantTranId: p.merchantTranId,
        customerName: order.customerName,
      });
    }
  }

  return list;
}

function findMatchingEntries(payment, entries) {
  const matches = [];
  const amt = normalizeAmount(payment.paidAmount);
  const payDate = new Date(payment.paymentDate);
  const utr = normalizeUtr(getPaymentUtr(payment));
  const txnId = payment.transactionId ? String(payment.transactionId).trim() : "";
  const chq = payment.chequeNumber ? String(payment.chequeNumber).trim() : "";

  for (const e of entries) {
    const eAmt = normalizeAmount(e.amount);
    const eDate = new Date(e.txnDate);
    const refN = normalizeUtr(e.referenceNumber || "");
    const eTxn = e.transactionId ? String(e.transactionId).trim() : "";
    const eChq = e.chequeNumber ? String(e.chequeNumber).trim() : "";

    if (utr && refN && utr === refN && Math.abs(amt - eAmt) < AMOUNT_EPS) {
      matches.push({ entry: e, by: "UTR" });
      continue;
    }
    if (txnId && eTxn && txnId === eTxn && Math.abs(amt - eAmt) < AMOUNT_EPS) {
      matches.push({ entry: e, by: "TXN_ID" });
      continue;
    }
    if (chq && eChq && chq === eChq && Math.abs(amt - eAmt) < AMOUNT_EPS) {
      matches.push({ entry: e, by: "CHEQUE" });
      continue;
    }
    if (Math.abs(amt - eAmt) < AMOUNT_EPS && Math.abs(eDate - payDate) <= DATE_WINDOW_MS) {
      matches.push({ entry: e, by: "AMOUNT_DATE" });
    }
  }

  return matches;
}

/**
 * Run reconciliation using BankStatementEntry rows in DB for the date range.
 */
export async function runReconciliation(dateFrom, dateTo, source = "all") {
  const errors = [];
  const matched = [];
  let updatedCount = 0;

  const entries = await getStoredEntriesForRange(dateFrom, dateTo);
  if (!entries.length) {
    return {
      matched,
      updatedCount,
      errors: [],
      message: "No bank statement entries in range — call POST .../bank-statement first",
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
    const matches = findMatchingEntries(pay, available);
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      try {
        if (pay.source === "order") {
          const order = await Order.findById(pay.orderMongoId);
          if (!order) continue;
          const subdoc = order.payment.id(pay.paymentId);
          if (!subdoc) continue;
          subdoc.bankReconciliationConflict = true;
          subdoc.bankVerificationStatus = "VERIFY_FAILED";
          await order.save();
        } else {
          const order = await AgriSalesOrder.findById(pay.orderMongoId);
          if (!order) continue;
          const subdoc = order.payment.id(pay.paymentId);
          if (!subdoc) continue;
          subdoc.bankReconciliationConflict = true;
          subdoc.bankVerificationStatus = "VERIFY_FAILED";
          await order.save();
        }
        errors.push({
          paymentId: pay.paymentId,
          message: "Multiple bank matches — marked VERIFY_FAILED",
        });
      } catch (err) {
        errors.push({ paymentId: pay.paymentId, message: err.message });
      }
      continue;
    }

    const { entry, by } = matches[0];
    if (entry._id) usedEntryIds.add(String(entry._id));
    try {
      if (pay.source === "order") {
        const order = await Order.findById(pay.orderMongoId);
        if (!order) {
          errors.push({ paymentId: pay.paymentId, message: "Order not found" });
          continue;
        }
        const subdoc = order.payment.id(pay.paymentId);
        if (!subdoc || subdoc.paymentStatus !== "PENDING") continue;
        subdoc.paymentStatus = "BANK_VERIFIED";
        subdoc.bankVerificationStatus = "BANK_VERIFIED";
        subdoc.bankVerificationSource = "STATEMENT_API";
        subdoc.bankVerificationMatchedBy = by;
        subdoc.bankReferenceNumber = entry.referenceNumber || "";
        subdoc.bankNarration = entry.narration || "";
        subdoc.bankAmount = entry.amount;
        subdoc.bankEntryDate = entry.txnDate;
        subdoc.bankRawResponse = entry.rawResponse || entry;
        subdoc.bankReconciliationConflict = false;
        if (!subdoc.utrNumber && pay.utrNumber) subdoc.utrNumber = pay.utrNumber;
        await order.save();
        try {
          const fs = await import("../modules/finance/integration/financeShadow.js");
          fs.shadowBankPaymentVerified({
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
        if (!order) {
          errors.push({ paymentId: pay.paymentId, message: "Agri order not found" });
          continue;
        }
        const subdoc = order.payment.id(pay.paymentId);
        if (!subdoc || subdoc.paymentStatus !== "PENDING") continue;
        subdoc.paymentStatus = "BANK_VERIFIED";
        subdoc.bankVerificationStatus = "BANK_VERIFIED";
        subdoc.bankVerificationSource = "STATEMENT_API";
        subdoc.bankVerificationMatchedBy = by;
        subdoc.bankReferenceNumber = entry.referenceNumber || "";
        subdoc.bankNarration = entry.narration || "";
        subdoc.bankAmount = entry.amount;
        subdoc.bankEntryDate = entry.txnDate;
        subdoc.bankRawResponse = entry.rawResponse || entry;
        subdoc.bankReconciliationConflict = false;
        if (!subdoc.utrNumber && pay.utrNumber) subdoc.utrNumber = pay.utrNumber;
        await order.save();
        try {
          const fs = await import("../modules/finance/integration/financeShadow.js");
          fs.shadowBankPaymentVerified({
            paymentId: pay.paymentId,
            orderMongoId: pay.orderMongoId,
            amount: pay.paidAmount,
            userId: null,
          });
        } catch (shadowErr) {
          console.error("[Finance] shadow bank verify agri:", shadowErr?.message || shadowErr);
        }
      }
      updatedCount += 1;
      matched.push({
        source: pay.source,
        orderId: pay.orderId,
        paymentId: pay.paymentId,
        paidAmount: pay.paidAmount,
        matchedBy: by,
      });
    } catch (err) {
      errors.push({ paymentId: pay.paymentId, message: err.message });
    }
  }

  return { matched, updatedCount, errors };
}
