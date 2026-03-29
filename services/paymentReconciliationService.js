/**
 * Payment reconciliation: match our PENDING payments (UTR+amount or cheque+amount) with bank data,
 * set matched to BANK_VERIFIED (Level 1). Accountant then approves to COLLECTED (Level 2) via updatePaymentStatus.
 */

import Order from "../models/order.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import { runReconciliation } from "./reconciliation.service.js";

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
        { "payment.merchantTranId": { $exists: true, $ne: "", $type: "string" } },
        { "payment.utrNumber": { $exists: true, $ne: "", $type: "string" } },
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
        if (p.bankVerificationStatus && p.bankVerificationStatus !== "PENDING") continue;
        const hasRef =
          (p.transactionId && String(p.transactionId).trim()) ||
          (p.chequeNumber && String(p.chequeNumber).trim()) ||
          (p.qrReferenceId && String(p.qrReferenceId).trim()) ||
          (p.merchantTranId && String(p.merchantTranId).trim()) ||
          (p.utrNumber && String(p.utrNumber).trim());
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
          utrNumber: p.utrNumber,
          chequeNumber: p.chequeNumber,
          qrReferenceId: p.qrReferenceId,
          merchantTranId: p.merchantTranId,
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
        { "payment.merchantTranId": { $exists: true, $ne: "", $type: "string" } },
        { "payment.utrNumber": { $exists: true, $ne: "", $type: "string" } },
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
        if (p.bankVerificationStatus && p.bankVerificationStatus !== "PENDING") continue;
        const hasRef =
          (p.transactionId && String(p.transactionId).trim()) ||
          (p.chequeNumber && String(p.chequeNumber).trim()) ||
          (p.qrReferenceId && String(p.qrReferenceId).trim()) ||
          (p.merchantTranId && String(p.merchantTranId).trim()) ||
          (p.utrNumber && String(p.utrNumber).trim());
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
          utrNumber: p.utrNumber,
          chequeNumber: p.chequeNumber,
          qrReferenceId: p.qrReferenceId,
          merchantTranId: p.merchantTranId,
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
        const b = p.bankVerificationStatus;
        if (b === "VERIFY_FAILED" || b === "PENDING") continue;
        if (b && b !== "BANK_VERIFIED" && b !== "NOT_REQUIRED") continue;
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
          utrNumber: p.utrNumber,
          chequeNumber: p.chequeNumber,
          bankVerificationStatus: p.bankVerificationStatus,
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
        const b = p.bankVerificationStatus;
        if (b === "VERIFY_FAILED" || b === "PENDING") continue;
        if (b && b !== "BANK_VERIFIED" && b !== "NOT_REQUIRED") continue;
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
          utrNumber: p.utrNumber,
          chequeNumber: p.chequeNumber,
          bankVerificationStatus: p.bankVerificationStatus,
          customerName: order.customerName,
          customerMobile: order.customerMobile,
        });
      }
    }
  }

  return list;
}

/**
 * Reconcile: match uncleared payments to BankStatementEntry rows (ICICI statement API).
 * @param {string} dateFrom - ISO date string
 * @param {string} dateTo - ISO date string
 * @returns {Promise<{ matched: Array, updatedCount: number, errors: Array, message?: string }>}
 */
export async function reconcile(dateFrom, dateTo, source = "all") {
  return runReconciliation(dateFrom, dateTo, source);
}
