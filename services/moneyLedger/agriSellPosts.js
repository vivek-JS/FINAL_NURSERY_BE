import { postEntry, getPartyBalance, roundMoney } from "./postEntry.js";
import { resolveDocumentLedgerEntryDate } from "../../utility/istLedgerDate.js";
import Merchant from "../../models/merchant.model.js";
import MoneyLedgerEntry from "../../models/moneyLedgerEntry.model.js";
import { postLedgerReversal } from "./reversals.js";

export async function syncRamAgriMerchantAr(merchantId) {
  if (!merchantId) return;
  const bal = await getPartyBalance({
    book: "RAM_AGRI",
    side: "AR",
    partyType: "MERCHANT",
    partyId: merchantId,
  });
  await Merchant.findByIdAndUpdate(merchantId, {
    outstandingAmount: bal.balance,
  });
}

/**
 * Post SELL debit (+ COLLECTED payments as PAYMENT credits) for agri B2B order.
 */
export async function postAgriSalesOrderAr(order, userId) {
  if (!order?._id) return { ok: false, error: "Missing agri sales order", status: 400 };
  const merchantId = order.merchant?._id || order.merchant;
  if (!merchantId) return { ok: true, skipped: true, reason: "no_merchant" };

  const total = roundMoney(
    Number(order.originalTotalAmount) > 0
      ? order.originalTotalAmount
      : order.totalAmount
  );
  if (total <= 0) return { ok: true, skipped: true };

  const merchant = await Merchant.findById(merchantId).select("name").lean();
  const partyName = merchant?.name || order.customerName || "";
  const entryDate = resolveDocumentLedgerEntryDate(
    order.orderDate || order.createdAt || new Date()
  );

  const products = (Array.isArray(order.lineItems) && order.lineItems.length
    ? order.lineItems
    : [
        {
          productName: order.productName,
          ramAgriCropName: order.ramAgriCropName,
          ramAgriVarietyName: order.ramAgriVarietyName,
          quantity: order.quantity,
          rate: order.rate,
          amount: order.totalAmount,
        },
      ]
  )
    .map((l) => ({
      productName:
        l.productName || l.ramAgriVarietyName || l.ramAgriCropName || "Item",
      qty: Number(l.quantity) || 0,
      rate: Number(l.rate) || 0,
      amount: Number(l.amount) || Number(l.quantity || 0) * Number(l.rate || 0),
      crop: l.ramAgriCropName || "",
      variety: l.ramAgriVarietyName || "",
    }))
    .filter((p) => p.productName);

  const sellPost = await postEntry({
    book: "RAM_AGRI",
    side: "AR",
    partyType: "MERCHANT",
    partyId: merchantId,
    partyName,
    entryDate,
    refType: "SELL",
    documentType: "AgriSalesOrder",
    documentId: order._id,
    documentNumber: order.orderNumber || "",
    debit: total,
    description: `B2B sale ${order.orderNumber || ""}`.trim(),
    reference: order.orderNumber || "",
    idempotencyKey: `ram_agri:ar:sell:${order._id}`,
    createdBy: userId,
    metadata: { products },
  });

  const paymentResults = [];
  for (const p of order.payment || []) {
    if (String(p.paymentStatus).toUpperCase() !== "COLLECTED") continue;
    const amt = roundMoney(p.paidAmount);
    if (amt <= 0) continue;
    const pid = p._id;
    if (!pid) continue;
    const r = await postEntry({
      book: "RAM_AGRI",
      side: "AR",
      partyType: "MERCHANT",
      partyId: merchantId,
      partyName,
      entryDate: p.paymentDate || order.orderDate || new Date(),
      refType: "PAYMENT",
      documentType: "AgriSalesOrder",
      documentId: order._id,
      documentNumber: order.orderNumber || "",
      paymentId: pid,
      credit: amt,
      description: `Payment ${p.modeOfPayment || ""} on ${order.orderNumber || ""}`.trim(),
      reference: order.orderNumber || "",
      idempotencyKey: `ram_agri:ar:sell:${order._id}:payment:${pid}`,
      createdBy: userId,
      metadata: { modeOfPayment: p.modeOfPayment, paymentStatus: p.paymentStatus },
    });
    paymentResults.push(r);
  }

  await syncRamAgriMerchantAr(merchantId);
  return { ok: true, sellPost, paymentResults };
}

export async function postAgriSalesPaymentAr(order, payment, userId) {
  const merchantId = order?.merchant?._id || order?.merchant;
  if (!merchantId) return { ok: true, skipped: true, reason: "no_merchant" };
  if (String(payment?.paymentStatus || "").toUpperCase() !== "COLLECTED") {
    return { ok: true, skipped: true, reason: "not_collected" };
  }
  const amt = roundMoney(payment.paidAmount);
  if (amt <= 0) return { ok: true, skipped: true };
  if (!payment._id) return { ok: false, error: "payment._id required", status: 400 };

  const merchant = await Merchant.findById(merchantId).select("name").lean();
  const r = await postEntry({
    book: "RAM_AGRI",
    side: "AR",
    partyType: "MERCHANT",
    partyId: merchantId,
    partyName: merchant?.name || order.customerName || "",
    entryDate: payment.paymentDate || new Date(),
    refType: "PAYMENT",
    documentType: "AgriSalesOrder",
    documentId: order._id,
    documentNumber: order.orderNumber || "",
    paymentId: payment._id,
    credit: amt,
    description: `Payment ${payment.modeOfPayment || ""} on ${order.orderNumber || ""}`.trim(),
    reference: order.orderNumber || "",
    idempotencyKey: `ram_agri:ar:sell:${order._id}:payment:${payment._id}`,
    createdBy: userId,
    metadata: { modeOfPayment: payment.modeOfPayment },
  });
  await syncRamAgriMerchantAr(merchantId);
  return r;
}

/** Reverse PAYMENT ledger line when agri payment is uncollected. */
export async function reverseAgriSalesPaymentAr(order, payment, userId, reason = "") {
  const merchantId = order?.merchant?._id || order?.merchant;
  if (!merchantId || !payment?._id) return { ok: true, skipped: true };

  const entry = await MoneyLedgerEntry.findOne({
    book: "RAM_AGRI",
    side: "AR",
    documentType: "AgriSalesOrder",
    documentId: order._id,
    paymentId: payment._id,
    refType: "PAYMENT",
  })
    .select("_id")
    .lean();

  if (!entry) return { ok: true, skipped: true, reason: "no_payment_entry" };

  const r = await postLedgerReversal({
    entryId: entry._id,
    reason: reason || `Payment uncollected on ${order.orderNumber || ""}`,
    userId,
    idempotencySuffix: "agri_pay_uncollect",
  });
  await syncRamAgriMerchantAr(merchantId);
  return r;
}

/** Reverse SELL + payment lines when agri B2B order is cancelled. */
export async function reverseAgriSalesOrderAr(order, userId, reason = "") {
  const merchantId = order?.merchant?._id || order?.merchant;
  if (!merchantId) return { ok: true, skipped: true };

  const entries = await MoneyLedgerEntry.find({
    book: "RAM_AGRI",
    side: "AR",
    documentType: "AgriSalesOrder",
    documentId: order._id,
    refType: { $in: ["SELL", "PAYMENT"] },
  })
    .select("_id refType")
    .lean();

  const results = [];
  for (const e of entries) {
    results.push(
      await postLedgerReversal({
        entryId: e._id,
        reason: reason || `Order cancelled ${order.orderNumber || ""}`,
        userId,
        idempotencySuffix: `cancel_${e.refType}`,
      })
    );
  }
  await syncRamAgriMerchantAr(merchantId);
  return { ok: true, results, reversed: results.filter((x) => x?.created).length };
}
