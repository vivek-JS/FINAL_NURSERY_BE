import { postEntry, getPartyBalance, roundMoney } from "./postEntry.js";
import Merchant from "../../models/merchant.model.js";

async function syncMerchantAr(merchantId) {
  if (!merchantId) return;
  const bal = await getPartyBalance({
    book: "BIOTECH",
    side: "AR",
    partyType: "MERCHANT",
    partyId: merchantId,
  });
  await Merchant.findByIdAndUpdate(merchantId, {
    outstandingAmount: bal.balance,
  });
}

/**
 * Post SELL debit (+ collected payments as PAYMENT credits) for classic sell order.
 */
export async function postSellOrderAr(sellOrder, userId) {
  if (!sellOrder?._id) return { ok: false, error: "Missing sell order", status: 400 };
  const total = roundMoney(sellOrder.totalAmount);
  if (total <= 0) return { ok: true, skipped: true };

  const merchantId = sellOrder.merchant?._id || sellOrder.merchant;
  if (!merchantId) {
    // Farmer / walk-in by name — use FARMER party type with synthetic ObjectId skip
    // Store under MERCHANT only when merchant exists; otherwise skip structured party
    // and use a hash? Plan says MERCHANT/FARMER — for buyerName-only, skip party cache sync.
    return { ok: true, skipped: true, reason: "no_merchant" };
  }

  const merchant = await Merchant.findById(merchantId).select("name").lean();
  const partyName = merchant?.name || sellOrder.buyerName || "";

  const sellPost = await postEntry({
    book: "BIOTECH",
    side: "AR",
    partyType: "MERCHANT",
    partyId: merchantId,
    partyName,
    entryDate: sellOrder.orderDate || new Date(),
    refType: "SELL",
    documentType: "SellOrder",
    documentId: sellOrder._id,
    documentNumber: sellOrder.orderNumber || "",
    debit: total,
    description: `Sell order ${sellOrder.orderNumber || ""}`,
    reference: sellOrder.orderNumber || "",
    idempotencyKey: `biotech:ar:sell:${sellOrder._id}`,
    createdBy: userId,
  });

  const paymentResults = [];
  for (const p of sellOrder.payment || []) {
    if (String(p.paymentStatus).toUpperCase() !== "COLLECTED") continue;
    const amt = roundMoney(p.paidAmount);
    if (amt <= 0) continue;
    const pid = p._id;
    const r = await postEntry({
      book: "BIOTECH",
      side: "AR",
      partyType: "MERCHANT",
      partyId: merchantId,
      partyName,
      entryDate: p.paymentDate || new Date(),
      refType: "PAYMENT",
      documentType: "SellOrder",
      documentId: sellOrder._id,
      documentNumber: sellOrder.orderNumber || "",
      paymentId: pid,
      credit: amt,
      description: `Payment ${p.modeOfPayment || ""} on ${sellOrder.orderNumber || ""}`,
      reference: sellOrder.orderNumber || "",
      idempotencyKey: `biotech:ar:sell:${sellOrder._id}:payment:${pid}`,
      createdBy: userId,
      metadata: { modeOfPayment: p.modeOfPayment, paymentStatus: p.paymentStatus },
    });
    paymentResults.push(r);
  }

  await syncMerchantAr(merchantId);
  return { ok: true, sellPost, paymentResults };
}

export async function postSellPaymentAr(sellOrder, payment, userId) {
  if (!sellOrder?.merchant) return { ok: true, skipped: true };
  if (String(payment?.paymentStatus || "").toUpperCase() !== "COLLECTED") {
    return { ok: true, skipped: true, reason: "not_collected" };
  }
  const merchantId = sellOrder.merchant._id || sellOrder.merchant;
  const amt = roundMoney(payment.paidAmount);
  if (amt <= 0) return { ok: true, skipped: true };

  const merchant = await Merchant.findById(merchantId).select("name").lean();
  const r = await postEntry({
    book: "BIOTECH",
    side: "AR",
    partyType: "MERCHANT",
    partyId: merchantId,
    partyName: merchant?.name || "",
    entryDate: payment.paymentDate || new Date(),
    refType: "PAYMENT",
    documentType: "SellOrder",
    documentId: sellOrder._id,
    documentNumber: sellOrder.orderNumber || "",
    paymentId: payment._id,
    credit: amt,
    description: `Payment ${payment.modeOfPayment || ""} on ${sellOrder.orderNumber || ""}`,
    reference: sellOrder.orderNumber || "",
    idempotencyKey: `biotech:ar:sell:${sellOrder._id}:payment:${payment._id}`,
    createdBy: userId,
    metadata: { modeOfPayment: payment.modeOfPayment },
  });
  await syncMerchantAr(merchantId);
  return r;
}
