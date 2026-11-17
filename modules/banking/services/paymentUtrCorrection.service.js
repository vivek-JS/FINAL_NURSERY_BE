/**
 * One-time UTR correction for a pending payment that has not been bank-checked.
 * The previous UTR and transaction id are kept on the payment.
 */

import mongoose from "mongoose";
import Order from "../../../models/order.model.js";
import AgriSalesOrder from "../../../models/agriSalesOrder.model.js";
import { normalizeUtr } from "../../../services/iciciBankService.js";
import { findExistingPaymentByUtr } from "../../../services/orderPayment.service.js";

const ALLOWED_ROLES = new Set(["ACCOUNTANT", "SUPER_ADMIN", "SUPERADMIN"]);
const UTR_RE = /^[A-Za-z0-9][A-Za-z0-9./-]{5,39}$/;

function roleAllowed(user) {
  const candidates = [user?.role, user?.jobTitle]
    .map((value) => String(value || "").trim().toUpperCase())
    .filter(Boolean);
  return candidates.some((value) => ALLOWED_ROLES.has(value));
}

function fail(status, error) {
  return { ok: false, status, error };
}

export async function correctPendingPaymentUtr({ source, orderMongoId, paymentId, utrNumber, user }) {
  if (!roleAllowed(user)) {
    return fail(403, "Only an accountant or super admin can correct a UTR");
  }
  if (!["order", "agriSales"].includes(source)) {
    return fail(400, "source must be order or agriSales");
  }
  if (!mongoose.isValidObjectId(orderMongoId) || !mongoose.isValidObjectId(paymentId)) {
    return fail(400, "Invalid payment");
  }

  const next = String(utrNumber || "").trim();
  if (!UTR_RE.test(next)) {
    return fail(400, "Enter a UTR or transaction id of 6 to 40 letters or digits");
  }

  const Model = source === "order" ? Order : AgriSalesOrder;
  const order = await Model.findById(orderMongoId);
  if (!order) return fail(404, "Order not found");
  const payment = order.payment.id(paymentId);
  if (!payment) return fail(404, "Payment not found");

  if (payment.paymentStatus !== "PENDING") {
    return fail(403, "Only a pending payment can have its UTR corrected");
  }
  if (payment.bankVerificationStatus === "BANK_VERIFIED" || payment.paymentStatus === "BANK_VERIFIED") {
    return fail(403, "This payment is already bank-checked");
  }
  if (
    payment.isWalletPayment ||
    payment.isDiscount ||
    payment.modeOfPayment === "Discount" ||
    String(payment.modeOfPayment || "").toLowerCase() === "cash"
  ) {
    return fail(400, "This payment has no bank UTR");
  }
  if (payment.utrCorrectedOnce || (payment.utrCorrections || []).length > 0) {
    return fail(403, "This UTR was already corrected once");
  }

  const previousUtr = String(payment.utrNumber || "").trim();
  const previousTransactionId = String(payment.transactionId || "").trim();
  const current = previousUtr || previousTransactionId;
  if (current && normalizeUtr(current) === normalizeUtr(next)) {
    return fail(400, "That is already the UTR on this payment");
  }

  const duplicate = await findExistingPaymentByUtr(next, { excludePaymentId: paymentId });
  if (duplicate) {
    return fail(409, `This UTR is already on order ${duplicate.orderLabel}`);
  }

  payment.utrCorrections = payment.utrCorrections || [];
  payment.utrCorrections.push({
    previousUtr,
    previousTransactionId,
    nextUtr: next,
    editedBy: user?._id || null,
    editedAt: new Date(),
  });
  payment.utrNumber = next;
  payment.transactionId = next;
  payment.utrCorrectedOnce = true;
  if (payment.bankVerificationStatus === "VERIFY_FAILED") {
    payment.bankVerificationStatus = "PENDING";
  }
  if (user?._id) payment.paymentUpdatedBy = user._id;
  await order.save();

  return {
    ok: true,
    paymentId: String(payment._id),
    utrNumber: next,
    correctedOnce: true,
    previousUtr: previousUtr || previousTransactionId,
  };
}
