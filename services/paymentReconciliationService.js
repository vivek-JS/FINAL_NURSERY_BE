/**
 * Payment reconciliation: match our PENDING payments (UTR+amount or cheque+amount) with bank data,
 * set matched to BANK_VERIFIED (Level 1). Accountant then approves to COLLECTED (Level 2) via updatePaymentStatus.
 */

import Order from "../models/order.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import { fetchBankTransactions, normalizeUtr, normalizeAmount } from "./iciciBankService.js";

/**
 * Get PENDING payments that have UTR (transactionId) or cheque number for reconciliation.
 * @param {Object} options - { dateFrom, dateTo, source: 'order'|'agriSales'|'all' }
 * @returns {Promise<Array>}
 */
export async function getUnclearedPayments(options = {}) {
  const { dateFrom, dateTo, source = "all" } = options;
  const list = [];

  const now = new Date();
  if (source === "all" || source === "order") {
    const query = {
      "payment.paymentStatus": "PENDING",
      $or: [
        { "payment.transactionId": { $exists: true, $ne: "", $type: "string" } },
        { "payment.chequeNumber": { $exists: true, $ne: "", $type: "string" } },
        { "payment.qrReferenceId": { $exists: true, $ne: "", $type: "string" } },
      ],
    };
    if (dateFrom || dateTo) {
      query["payment.paymentDate"] = {};
      if (dateFrom) query["payment.paymentDate"].$gte = new Date(dateFrom);
      if (dateTo) query["payment.paymentDate"].$lte = new Date(dateTo);
    }
    const orders = await Order.find(query)
      .select("orderId payment farmer dealer dealerOrder")
      .populate("farmer", "name village")
      .lean();

    for (const order of orders) {
      for (const p of order.payment || []) {
        if (p.paymentStatus !== "PENDING") continue;
        const hasRef = (p.transactionId && String(p.transactionId).trim()) || (p.chequeNumber && String(p.chequeNumber).trim()) || (p.qrReferenceId && String(p.qrReferenceId).trim());
        if (!hasRef) continue;
        if (p.qrExpiresAt && new Date(p.qrExpiresAt) < now) continue;
        if (dateFrom && new Date(p.paymentDate) < new Date(dateFrom)) continue;
        if (dateTo && new Date(p.paymentDate) > new Date(dateTo)) continue;
        list.push({
          source: "order",
          orderId: order.orderId,
          orderMongoId: order._id.toString(),
          paymentId: p._id.toString(),
          paidAmount: p.paidAmount,
          paymentDate: p.paymentDate,
          modeOfPayment: p.modeOfPayment,
          bankName: p.bankName,
          transactionId: p.transactionId,
          chequeNumber: p.chequeNumber,
          qrReferenceId: p.qrReferenceId,
          qrExpiresAt: p.qrExpiresAt,
          ref: p.transactionId || p.chequeNumber || p.qrReferenceId,
          farmerName: order.farmer?.name,
          village: order.farmer?.village,
          dealerOrder: order.dealerOrder,
        });
      }
    }
  }

  if (source === "all" || source === "agriSales") {
    const query = {
      "payment.paymentStatus": "PENDING",
      $or: [
        { "payment.transactionId": { $exists: true, $ne: "", $type: "string" } },
        { "payment.chequeNumber": { $exists: true, $ne: "", $type: "string" } },
        { "payment.qrReferenceId": { $exists: true, $ne: "", $type: "string" } },
      ],
    };
    if (dateFrom || dateTo) {
      query["payment.paymentDate"] = {};
      if (dateFrom) query["payment.paymentDate"].$gte = new Date(dateFrom);
      if (dateTo) query["payment.paymentDate"].$lte = new Date(dateTo);
    }
    const agriOrders = await AgriSalesOrder.find(query)
      .select("orderNumber payment customerName customerMobile")
      .lean();

    for (const order of agriOrders) {
      for (const p of order.payment || []) {
        if (p.paymentStatus !== "PENDING") continue;
        const hasRef = (p.transactionId && String(p.transactionId).trim()) || (p.chequeNumber && String(p.chequeNumber).trim()) || (p.qrReferenceId && String(p.qrReferenceId).trim());
        if (!hasRef) continue;
        if (p.qrExpiresAt && new Date(p.qrExpiresAt) < now) continue;
        if (dateFrom && new Date(p.paymentDate) < new Date(dateFrom)) continue;
        if (dateTo && new Date(p.paymentDate) > new Date(dateTo)) continue;
        list.push({
          source: "agriSales",
          orderId: order.orderNumber,
          orderMongoId: order._id.toString(),
          paymentId: p._id.toString(),
          paidAmount: p.paidAmount,
          paymentDate: p.paymentDate,
          modeOfPayment: p.modeOfPayment,
          bankName: p.bankName,
          transactionId: p.transactionId,
          chequeNumber: p.chequeNumber,
          qrReferenceId: p.qrReferenceId,
          qrExpiresAt: p.qrExpiresAt,
          ref: p.transactionId || p.chequeNumber || p.qrReferenceId,
          customerName: order.customerName,
          customerMobile: order.customerMobile,
        });
      }
    }
  }

  return list;
}

/**
 * Get payments with status BANK_VERIFIED for accountant approval (Tab 2).
 * @param {Object} options - { dateFrom, dateTo, source }
 * @returns {Promise<Array>}
 */
export async function getPaymentsForApproval(options = {}) {
  const { dateFrom, dateTo, source = "all" } = options;
  const list = [];

  if (source === "all" || source === "order") {
    const query = { "payment.paymentStatus": "BANK_VERIFIED" };
    if (dateFrom || dateTo) {
      query["payment.paymentDate"] = {};
      if (dateFrom) query["payment.paymentDate"].$gte = new Date(dateFrom);
      if (dateTo) query["payment.paymentDate"].$lte = new Date(dateTo);
    }
    const orders = await Order.find(query)
      .select("orderId payment farmer dealer dealerOrder")
      .populate("farmer", "name village")
      .lean();

    for (const order of orders) {
      for (const p of order.payment || []) {
        if (p.paymentStatus !== "BANK_VERIFIED") continue;
        list.push({
          source: "order",
          orderId: order.orderId,
          orderMongoId: order._id.toString(),
          paymentId: p._id.toString(),
          paidAmount: p.paidAmount,
          paymentDate: p.paymentDate,
          modeOfPayment: p.modeOfPayment,
          bankName: p.bankName,
          transactionId: p.transactionId,
          chequeNumber: p.chequeNumber,
          farmerName: order.farmer?.name,
          village: order.farmer?.village,
          dealerOrder: order.dealerOrder,
        });
      }
    }
  }

  if (source === "all" || source === "agriSales") {
    const query = { "payment.paymentStatus": "BANK_VERIFIED" };
    if (dateFrom || dateTo) {
      query["payment.paymentDate"] = {};
      if (dateFrom) query["payment.paymentDate"].$gte = new Date(dateFrom);
      if (dateTo) query["payment.paymentDate"].$lte = new Date(dateTo);
    }
    const agriOrders = await AgriSalesOrder.find(query)
      .select("orderNumber payment customerName customerMobile")
      .lean();

    for (const order of agriOrders) {
      for (let i = 0; i < (order.payment || []).length; i++) {
        const p = order.payment[i];
        if (p.paymentStatus !== "BANK_VERIFIED") continue;
        list.push({
          source: "agriSales",
          orderId: order.orderNumber,
          orderMongoId: order._id.toString(),
          paymentId: p._id.toString(),
          paymentIndex: i,
          paidAmount: p.paidAmount,
          paymentDate: p.paymentDate,
          modeOfPayment: p.modeOfPayment,
          bankName: p.bankName,
          transactionId: p.transactionId,
          chequeNumber: p.chequeNumber,
          customerName: order.customerName,
          customerMobile: order.customerMobile,
        });
      }
    }
  }

  return list;
}

/**
 * Reconcile: fetch bank transactions, match uncleared payments, set matched to BANK_VERIFIED.
 * @param {string} dateFrom - ISO date string
 * @param {string} dateTo - ISO date string
 * @returns {Promise<{ matched: Array, updatedCount: number, errors: Array }>}
 */
export async function reconcile(dateFrom, dateTo) {
  const errors = [];
  const matched = [];
  let updatedCount = 0;

  const uncleared = await getUnclearedPayments({ dateFrom, dateTo, source: "all" });
  let bankTransactions = [];
  try {
    bankTransactions = await fetchBankTransactions(new Date(dateFrom), new Date(dateTo));
  } catch (err) {
    errors.push({ message: "Failed to fetch bank transactions", error: err.message });
    return { matched, updatedCount, errors };
  }

  const bankByUtr = new Map();
  const bankByCheque = new Map();
  for (const t of bankTransactions) {
    const keyUtr = normalizeUtr(t.utrOrRef);
    const amt = normalizeAmount(t.amount);
    if (keyUtr) {
      const k = `${keyUtr}|${amt}`;
      if (!bankByUtr.has(k)) bankByUtr.set(k, t);
    }
    if (t.chequeNumber) {
      const k = `${String(t.chequeNumber).trim()}|${amt}`;
      if (!bankByCheque.has(k)) bankByCheque.set(k, t);
    }
  }

  for (const pay of uncleared) {
    const amount = normalizeAmount(pay.paidAmount);
    const refForUtr = pay.transactionId || pay.qrReferenceId;
    const utrKey = refForUtr ? `${normalizeUtr(refForUtr)}|${amount}` : null;
    const chequeKey = pay.chequeNumber ? `${String(pay.chequeNumber).trim()}|${amount}` : null;
    const matchedByUtr = utrKey && bankByUtr.has(utrKey);
    const matchedByCheque = chequeKey && bankByCheque.has(chequeKey);
    if (!matchedByUtr && !matchedByCheque) continue;

    const subdocExpiresAt = pay.qrExpiresAt ? new Date(pay.qrExpiresAt) : null;
    if (subdocExpiresAt && subdocExpiresAt < new Date()) continue;

    try {
      if (pay.source === "order") {
        const order = await Order.findById(pay.orderMongoId);
        if (!order) { errors.push({ paymentId: pay.paymentId, message: "Order not found" }); continue; }
        const subdoc = order.payment.id(pay.paymentId);
        if (!subdoc || subdoc.paymentStatus !== "PENDING") continue;
        if (subdoc.qrExpiresAt && new Date(subdoc.qrExpiresAt) < new Date()) continue;
        subdoc.paymentStatus = "BANK_VERIFIED";
        if (matchedByUtr && pay.qrReferenceId && !subdoc.transactionId) {
          const bankTxn = bankByUtr.get(utrKey);
          if (bankTxn && bankTxn.utrOrRef) subdoc.transactionId = String(bankTxn.utrOrRef).trim();
        }
        await order.save();
      } else if (pay.source === "agriSales") {
        const order = await AgriSalesOrder.findById(pay.orderMongoId);
        if (!order) { errors.push({ paymentId: pay.paymentId, message: "Agri order not found" }); continue; }
        const subdoc = order.payment.id(pay.paymentId);
        if (!subdoc || subdoc.paymentStatus !== "PENDING") continue;
        if (subdoc.qrExpiresAt && new Date(subdoc.qrExpiresAt) < new Date()) continue;
        subdoc.paymentStatus = "BANK_VERIFIED";
        if (matchedByUtr && pay.qrReferenceId && !subdoc.transactionId) {
          const bankTxn = bankByUtr.get(utrKey);
          if (bankTxn && bankTxn.utrOrRef) subdoc.transactionId = String(bankTxn.utrOrRef).trim();
        }
        await order.save();
      }
      updatedCount += 1;
      matched.push({
        source: pay.source,
        orderId: pay.orderId,
        paymentId: pay.paymentId,
        paidAmount: pay.paidAmount,
        ref: pay.ref,
      });
    } catch (err) {
      errors.push({ paymentId: pay.paymentId, message: err.message });
    }
  }

  return { matched, updatedCount, errors };
}
