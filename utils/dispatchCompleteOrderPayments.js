import AppError from "../utility/appError.js";
import User from "../models/user.model.js";
import DealerWallet from "../models/dealerWallet.js";
import { parsePositivePaymentAmount } from "./paymentValidation.js";

/**
 * Build farmer/dealer description string for wallet transaction notes (aligned with order.controller addNewPayment).
 */
export function formatOrderWalletDescriptionContext(order) {
  if (order.dealerOrder) return "Dealer Order";
  if (order.farmer && typeof order.farmer === "object" && order.farmer.name) {
    const farmerName = order.farmer.name || "Unknown Farmer";
    const farmerVillage = order.farmer.village || "Unknown Village";
    return `${farmerName} (${farmerVillage})`;
  }
  return "Unknown Customer";
}

/**
 * Normalize optional `newPayments` from dispatch-complete payload into order payment subdocuments.
 * Role rules mirror addNewPayment (ACCOUNTANT / SUPER_ADMIN may set COLLECTED; OFFICE_ADMIN stays PENDING).
 *
 * @param {unknown} rawList
 * @param {import("express").Request["user"]} reqUser
 * @param {import("mongoose").Document} order
 * @returns {Array<Record<string, unknown>>}
 */
export function buildDispatchCompletePaymentSubdocs(rawList, reqUser, order) {
  if (!rawList || !Array.isArray(rawList) || rawList.length === 0) return [];

  const userRole = reqUser?.jobTitle || reqUser?.role;
  const canMarkPaymentCollected =
    userRole === "ACCOUNTANT" ||
    userRole === "SUPER_ADMIN" ||
    userRole === "SUPERADMIN";

  const out = [];
  for (let i = 0; i < rawList.length; i++) {
    const row = rawList[i];
    const parsedAmount = parsePositivePaymentAmount(row.paidAmount, `payment index ${i} amount`);
    if (!parsedAmount.ok) {
      throw new AppError(parsedAmount.message, 400);
    }
    const amount = parsedAmount.amount;

    const isWalletPayment = Boolean(row.isWalletPayment);
    if (!isWalletPayment && !row.modeOfPayment) {
      throw new AppError(
        `modeOfPayment is required for non-wallet payment at index ${i}`,
        400
      );
    }

    let finalPaymentStatus = "PENDING";
    if (userRole === "OFFICE_ADMIN") {
      finalPaymentStatus = "PENDING";
    } else if (
      canMarkPaymentCollected &&
      row.paymentStatus &&
      (row.paymentStatus === "COLLECTED" || row.paymentStatus === "PENDING")
    ) {
      finalPaymentStatus = row.paymentStatus;
    }

    const modeOfPayment = isWalletPayment ? "Wallet" : row.modeOfPayment;
    const paymentDate = row.paymentDate ? new Date(row.paymentDate) : new Date();
    const utrTrim = row.utrNumber?.trim() || undefined;
    const txnTrim =
      row.transactionId != null && String(row.transactionId).trim() !== ""
        ? String(row.transactionId).trim()
        : undefined;

    out.push({
      paidAmount: amount,
      paymentStatus: finalPaymentStatus,
      paymentDate,
      bankName: row.bankName || "",
      receiptPhoto: Array.isArray(row.receiptPhoto) ? row.receiptPhoto : [],
      modeOfPayment,
      isWalletPayment,
      remark: row.remark || "",
      transactionId: txnTrim || utrTrim || undefined,
      chequeNumber: row.chequeNumber || undefined,
      utrNumber: utrTrim,
      customerName:
        row.customerName?.trim() ||
        (!order.dealerOrder && order.farmer?.name ? order.farmer.name : undefined),
    });
  }
  return out;
}

/**
 * Extra COLLECTED amount from pending dispatch-complete payment rows (for paymentCompleted on this save).
 */
export function sumCollectedFromNewPaymentSubdocs(subdocs) {
  return (subdocs || []).reduce((sum, p) => {
    if (p?.paymentStatus === "COLLECTED") {
      return sum + (Number(p.paidAmount) || 0);
    }
    return sum;
  }, 0);
}

async function resolveDealerIdForOrderWallet(order, session) {
  let dealerId = order.dealer;
  if (!dealerId && order.salesPerson) {
    const q = User.findById(order.salesPerson).select("jobTitle");
    if (session) q.session(session);
    const salesPerson = await q.lean();
    if (salesPerson?.jobTitle === "DEALER") {
      dealerId = order.salesPerson;
    }
  }
  return dealerId;
}

/**
 * Apply dealer wallet debits/credits for normalized payments (same rules as addNewPayment).
 * Call after the order document has been persisted in the same transaction.
 */
export async function applyWalletForDispatchNewPayments(
  order,
  normalizedSubdocs,
  farmerInfo,
  performedBy,
  session
) {
  if (!normalizedSubdocs?.length) return;

  const dealerId = await resolveDealerIdForOrderWallet(order, session);
  if (!dealerId) return;

  for (const newPayment of normalizedSubdocs) {
    const amount = Number(newPayment.paidAmount);
    const finalPaymentStatus = newPayment.paymentStatus;
    const isWalletPayment = newPayment.isWalletPayment;
    const modeOfPayment = newPayment.modeOfPayment;

    let walletAmount = 0;
    let description = "";

    if (
      isWalletPayment &&
      (finalPaymentStatus === "PENDING" || finalPaymentStatus === "COLLECTED")
    ) {
      walletAmount = -amount;
      description = `Wallet payment ${String(finalPaymentStatus).toLowerCase()} for Order #${order._id} - ${farmerInfo}`;
    } else if (
      order.dealerOrder &&
      finalPaymentStatus === "COLLECTED" &&
      !isWalletPayment
    ) {
      walletAmount = amount;
      description = `Payment collected for Order #${order._id} via ${modeOfPayment} - ${farmerInfo}`;
    } else if (
      order.dealerOrder &&
      isWalletPayment &&
      (finalPaymentStatus === "PENDING" || finalPaymentStatus === "COLLECTED")
    ) {
      walletAmount = -amount;
      description = `Wallet payment ${String(finalPaymentStatus).toLowerCase()} for Dealer Order #${order._id} - ${farmerInfo}`;
    } else {
      walletAmount = 0;
      description = `Payment recorded (no wallet impact) for Order #${order._id} - ${farmerInfo}`;
    }

    if (walletAmount !== 0) {
      await DealerWallet.addPayment(
        dealerId,
        walletAmount,
        description,
        performedBy || dealerId,
        "ORDER_PAYMENT",
        order._id,
        session
      );
    }
  }
}
