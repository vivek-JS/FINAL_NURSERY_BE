import mongoose from "mongoose";
import Order from "../models/order.model.js";
import User from "../models/user.model.js";
import DealerWallet from "../models/dealerWallet.js";
import AppError from "../utility/appError.js";
import { applyPaymentTimingToPayment } from "../utils/paymentTiming.js";
import { stampPaymentRecordedBy, stampPaymentUpdatedBy } from "../utils/paymentAudit.js";
import { formatOrderWalletDescriptionContext } from "../utils/dispatchCompleteOrderPayments.js";
import {
  ensureFarmerPlantOrderDebit,
  recordFarmerPlantLedgerPaymentTransition,
  shouldLogFarmerPlantLedger,
} from "../utils/farmerPlantOrderLedgerHelper.js";
import { syncDealerLedgerForOrder } from "../utils/dealerLedgerHelper.js";
import { DISCOUNT_PAYMENT_MODE, isDiscountPayment } from "../utils/orderDiscountPayment.js";

export function mergeRemarkWithPayee(remark, receiptPayeeName) {
  const r = String(remark || "").trim();
  const p = String(receiptPayeeName || "").trim();
  if (!p) return r;
  const payeeLine = `Payee (receipt): ${p}`;
  if (r.includes(payeeLine)) return r;
  return r ? `${r}\n${payeeLine}` : payeeLine;
}

export function resolveFinalPaymentStatus(reqUser, requestedStatus) {
  const userRole = reqUser?.jobTitle || reqUser?.role;
  const canMarkPaymentCollected =
    userRole === "ACCOUNTANT" ||
    userRole === "SUPER_ADMIN" ||
    userRole === "SUPERADMIN";

  if (userRole === "OFFICE_ADMIN") return "PENDING";
  if (
    canMarkPaymentCollected &&
    requestedStatus &&
    (requestedStatus === "COLLECTED" || requestedStatus === "PENDING")
  ) {
    return requestedStatus;
  }
  return "PENDING";
}

export function normalizePaymentRow(row, reqUser, order, { extraReceiptUrls = [] } = {}) {
  const amount = Number(row.paidAmount);
  if (Number.isNaN(amount) || amount === 0) {
    throw new AppError("Invalid payment amount", 400);
  }

  const isWalletPayment = Boolean(row.isWalletPayment);
  if (!isWalletPayment && !row.modeOfPayment) {
    throw new AppError("modeOfPayment is required for non-wallet payment", 400);
  }

  const finalPaymentStatus = resolveFinalPaymentStatus(reqUser, row.paymentStatus);
  const modeOfPayment = isWalletPayment ? "Wallet" : row.modeOfPayment;
  const utrTrim = row.utrNumber?.trim() || undefined;
  const txnTrim =
    row.transactionId != null && String(row.transactionId).trim() !== ""
      ? String(row.transactionId).trim()
      : undefined;

  const receiptPhoto = [
    ...(Array.isArray(row.receiptPhoto) ? row.receiptPhoto : row.receiptPhoto ? [row.receiptPhoto] : []),
    ...extraReceiptUrls,
  ].filter(Boolean);

  const isDiscount = isDiscountPayment(row);
  if (isDiscount && isWalletPayment) {
    throw new AppError("Discount cannot be a wallet payment", 400);
  }

  const payment = {
    paidAmount: amount,
    paymentStatus: finalPaymentStatus,
    paymentDate: row.paymentDate ? new Date(row.paymentDate) : new Date(),
    bankName: isDiscount ? "" : row.bankName || "",
    receiptPhoto: isDiscount ? [] : receiptPhoto,
    modeOfPayment: isDiscount ? DISCOUNT_PAYMENT_MODE : modeOfPayment,
    isWalletPayment: isDiscount ? false : isWalletPayment,
    isDiscount,
    remark: mergeRemarkWithPayee(row.remark, row.receiptPayeeName),
    transactionId: isDiscount ? undefined : txnTrim || utrTrim || undefined,
    chequeNumber: isDiscount ? undefined : row.chequeNumber?.trim() || undefined,
    utrNumber: isDiscount ? undefined : utrTrim,
    bankVerificationStatus: isDiscount ? "NOT_REQUIRED" : undefined,
    customerName:
      row.customerName?.trim() ||
      (!order.dealerOrder && order.farmer?.name ? order.farmer.name : undefined),
  };
  stampPaymentRecordedBy(payment, reqUser);
  if (finalPaymentStatus !== "PENDING") {
    stampPaymentUpdatedBy(payment, reqUser);
  }
  return payment;
}

/** Payment modes that do not require a receipt photo. Cheque carries its own cheque number. */
export const RECEIPT_OPTIONAL_MODES = new Set([
  "Cash",
  "NEFT/RTGS",
  "UPI",
  "Cheque",
  DISCOUNT_PAYMENT_MODE,
]);

export function validatePaymentRow(row, index = 0) {
  const amount = Number(row.paidAmount);
  if (Number.isNaN(amount) || amount <= 0) {
    throw new AppError(`Invalid payment amount at index ${index}`, 400);
  }

  const isWalletPayment = Boolean(row.isWalletPayment);
  const mode = isWalletPayment ? "Wallet" : row.modeOfPayment;

  if (!isWalletPayment && !mode) {
    throw new AppError(`Payment mode required at index ${index}`, 400);
  }

  if (isDiscountPayment({ ...row, modeOfPayment: mode })) {
    if (isWalletPayment) {
      throw new AppError(`Discount cannot be a wallet payment at index ${index}`, 400);
    }
    if (!String(row.remark || "").trim()) {
      throw new AppError(`Remark required for Discount at index ${index}`, 400);
    }
    return;
  }

  if (!isWalletPayment && mode && !RECEIPT_OPTIONAL_MODES.has(mode)) {
    const photos = Array.isArray(row.receiptPhoto) ? row.receiptPhoto : [];
    if (!photos.length) {
      throw new AppError(`Receipt photo required for ${mode} at index ${index}`, 400);
    }
  }

  if (mode === "UPI" && !isWalletPayment) {
    const utr = String(row.utrNumber || "").trim() || String(row.transactionId || "").trim();
    if (!utr) {
      throw new AppError(`UTR required for UPI at index ${index}`, 400);
    }
  }
}

export async function resolveDealerIdForOrderWallet(order, session) {
  let dealerId = order.dealer;
  if (!dealerId && order.salesPerson) {
    const q = User.findById(order.salesPerson).select("jobTitle");
    if (session) q.session(session);
    const salesPerson = await q.lean();
    if (salesPerson?.jobTitle === "DEALER") {
      dealerId = order.salesPerson;
    }
  }
  return dealerId || null;
}

export async function getWalletAvailableAmount(dealerId, session) {
  let q = DealerWallet.findOne({ dealer: dealerId }).select("availableAmount");
  if (session) q = q.session(session);
  const wallet = await q.lean();
  return Number(wallet?.availableAmount) || 0;
}

export function computeWalletDebitAmount(order, payment, farmerInfo) {
  const amount = Number(payment.paidAmount);
  const finalPaymentStatus = payment.paymentStatus;
  const isWalletPayment = payment.isWalletPayment;

  if (
    isWalletPayment &&
    (finalPaymentStatus === "PENDING" || finalPaymentStatus === "COLLECTED")
  ) {
    return -amount;
  }
  if (
    order.dealerOrder &&
    isWalletPayment &&
    (finalPaymentStatus === "PENDING" || finalPaymentStatus === "COLLECTED")
  ) {
    return -amount;
  }
  return 0;
}

function walletDescription(order, payment, farmerInfo) {
  const st = String(payment.paymentStatus || "pending").toLowerCase();
  if (order.dealerOrder) {
    return `Wallet payment ${st} for Dealer Order #${order._id} - ${farmerInfo}`;
  }
  return `Wallet payment ${st} for Order #${order._id} - ${farmerInfo}`;
}

async function applyLedgersForSavedPayments(order, savedPayments, reqUser, session) {
  if (shouldLogFarmerPlantLedger(order)) {
    await ensureFarmerPlantOrderDebit(order, { userId: reqUser?._id, session });
    for (const payment of savedPayments) {
      await recordFarmerPlantLedgerPaymentTransition(
        order,
        payment,
        null,
        payment.paymentStatus,
        { userId: reqUser?._id, session }
      );
    }
  }
  await syncDealerLedgerForOrder(order, { userId: reqUser?._id, session });
}

/**
 * Add one or more payments atomically (order + wallet + ledgers).
 * @param {string} orderId Mongo _id
 * @param {object[]} rawPayments Request body rows
 * @param {object} reqUser Authenticated user
 * @param {{ extraReceiptUrls?: string[] }} options
 */
export async function addPaymentsToOrder(orderId, rawPayments, reqUser, options = {}) {
  if (!Array.isArray(rawPayments) || rawPayments.length === 0) {
    throw new AppError("payments array is required", 400);
  }

  rawPayments.forEach((row, i) => validatePaymentRow(row, i));

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findById(orderId)
      .populate("farmer", "name village mobileNumber taluka talukaName")
      .populate("plantName", "name")
      .session(session);

    if (!order) {
      throw new AppError("Order not found", 404);
    }

    const normalized = rawPayments.map((row, i) => {
      const extra =
        i === 0 && options.extraReceiptUrls?.length ? { extraReceiptUrls: options.extraReceiptUrls } : {};
      const subdoc = normalizePaymentRow(row, reqUser, order, extra);
      applyPaymentTimingToPayment(subdoc, order);
      return subdoc;
    });

    const dealerId = await resolveDealerIdForOrderWallet(order, session);
    const walletDebitTotal = normalized
      .filter((p) => p.isWalletPayment)
      .reduce((s, p) => s + Number(p.paidAmount), 0);

    if (walletDebitTotal > 0) {
      if (!dealerId) {
        throw new AppError("Wallet payment requires a dealer on this order", 400);
      }
      const available = await getWalletAvailableAmount(dealerId, session);
      if (walletDebitTotal > available + 0.001) {
        throw new AppError(
          `Insufficient wallet balance. Available: ₹${available.toLocaleString()}`,
          400
        );
      }
    }

    const farmerInfo = formatOrderWalletDescriptionContext(order);
    const performedBy = reqUser?._id || dealerId;
    const startLen = order.payment.length;

    for (const subdoc of normalized) {
      order.payment.push(subdoc);
    }
    await order.save({ session });

    const savedPayments = order.payment.slice(startLen);
    const walletTransactions = [];

    if (dealerId) {
      for (const payment of savedPayments) {
        const walletAmount = computeWalletDebitAmount(order, payment, farmerInfo);
        if (walletAmount === 0) continue;
        const tx = await DealerWallet.addPayment(
          dealerId,
          walletAmount,
          walletDescription(order, payment, farmerInfo),
          performedBy,
          "ORDER_PAYMENT",
          order._id,
          session,
          { strictLedger: true, paymentId: payment._id }
        );
        if (tx) walletTransactions.push(tx);
      }
    }

    await applyLedgersForSavedPayments(order, savedPayments, reqUser, session);

    await session.commitTransaction();

    for (const payment of savedPayments) {
      const { emitPlantPaymentEvent } = await import("../utils/orderEventDualWrite.js");
      emitPlantPaymentEvent(order._id, payment, {
        userId: reqUser?._id,
        actorName: reqUser?.name,
      }).catch((e) => console.error("[OrderEvent] payment emit:", e?.message || e));
    }

    const hasCollected = savedPayments.some((p) => p.paymentStatus === "COLLECTED");

    return {
      order,
      savedPayments,
      walletTransactions,
      hasCollected,
      walletDebited: walletDebitTotal,
    };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}
