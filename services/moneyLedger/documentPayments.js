import mongoose from "mongoose";
import PurchaseOrder from "../../models/purchaseOrder.model.js";
import MerchantSellOrder from "../../models/sellOrder.model.js";
import AgriSalesOrder from "../../models/agriSalesOrder.model.js";
import Supplier from "../../models/supplier.model.js";
import Merchant from "../../models/merchant.model.js";
import { postEntry, roundMoney } from "./postEntry.js";
import { syncSupplierOutstanding } from "./purchasePosts.js";
import { postSellPaymentAr } from "./sellPosts.js";
import { postAgriSalesPaymentAr } from "./agriSellPosts.js";

function paymentStatusFromPaid(total, paid) {
  if (paid <= 0) return "pending";
  if (paid + 0.009 >= total) return "paid";
  return "partial";
}

async function resolvePoParty(po) {
  const supplierId = po.supplier?._id || po.supplier;
  if (!supplierId) return null;
  const s = await Supplier.findById(supplierId).select("name").lean();
  if (s) return { partyType: "SUPPLIER", partyId: s._id, partyName: s.name || "" };
  const m = await Merchant.findById(supplierId).select("name").lean();
  if (m) return { partyType: "MERCHANT", partyId: m._id, partyName: m.name || "" };
  return { partyType: "SUPPLIER", partyId: supplierId, partyName: "" };
}

/**
 * Add payment on PO (AP), SellOrder (Biotech AR), or AgriSalesOrder (Ram Agri B2B AR).
 * body: { documentType, documentId, amount, modeOfPayment, paymentDate, paymentStatus, book?, remark, ... }
 */
export async function addDocumentPayment({
  documentType,
  documentId,
  amount,
  modeOfPayment = "Cash",
  paymentDate,
  paymentStatus = "COLLECTED",
  book,
  remark = "",
  bankName,
  transactionId,
  chequeNumber,
  upiId,
  userId,
} = {}) {
  const amt = roundMoney(amount);
  if (amt <= 0) return { ok: false, error: "amount must be > 0", status: 400 };
  if (!mongoose.isValidObjectId(documentId)) {
    return { ok: false, error: "Valid documentId required", status: 400 };
  }

  const type = String(documentType || "").toLowerCase();
  const status = String(paymentStatus || "COLLECTED").toUpperCase();

  if (type === "purchaseorder" || type === "po" || type === "purchase_order") {
    const po = await PurchaseOrder.findById(documentId);
    if (!po) return { ok: false, error: "Purchase order not found", status: 404 };

    const payment = {
      paidAmount: amt,
      paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
      modeOfPayment,
      paymentStatus: status,
      bankName,
      transactionId,
      chequeNumber,
      upiId,
      remark,
      createdBy: userId,
    };
    po.payments = po.payments || [];
    po.payments.push(payment);
    const collected = (po.payments || [])
      .filter((p) => String(p.paymentStatus).toUpperCase() === "COLLECTED")
      .reduce((s, p) => s + (Number(p.paidAmount) || 0), 0);
    po.paidAmount = roundMoney(collected);
    po.paymentStatus = paymentStatusFromPaid(Number(po.totalAmount) || 0, po.paidAmount);
    po.updatedBy = userId;
    await po.save();

    const savedPayment = po.payments[po.payments.length - 1];
    const party = await resolvePoParty(po);
    if (!party) return { ok: false, error: "PO has no supplier", status: 400 };

    // Split payment across books if book not forced: prefer BIOTECH unless Ram Agri AP balance dominates
    let targetBook = book;
    if (!targetBook || !["BIOTECH", "RAM_AGRI"].includes(targetBook)) {
      targetBook = "BIOTECH";
    }

    let ledgerResult = { ok: true, skipped: true };
    if (status === "COLLECTED") {
      ledgerResult = await postEntry({
        book: targetBook,
        side: "AP",
        partyType: party.partyType,
        partyId: party.partyId,
        partyName: party.partyName,
        entryDate: savedPayment.paymentDate,
        refType: "PAYMENT",
        documentType: "PurchaseOrder",
        documentId: po._id,
        documentNumber: po.poNumber || "",
        paymentId: savedPayment._id,
        debit: amt,
        description: `Supplier payment ${modeOfPayment} on ${po.poNumber || ""}`,
        reference: po.poNumber || "",
        idempotencyKey: `${targetBook.toLowerCase()}:ap:po:${po._id}:payment:${savedPayment._id}`,
        createdBy: userId,
        metadata: { modeOfPayment, remark },
      });
      await syncSupplierOutstanding(party.partyType, party.partyId);
    }

    return { ok: true, data: { purchaseOrder: po, payment: savedPayment, ledger: ledgerResult } };
  }

  if (type === "sellorder" || type === "sell_order" || type === "so") {
    const order = await MerchantSellOrder.findById(documentId);
    if (!order) return { ok: false, error: "Sell order not found", status: 404 };

    order.payment.push({
      paidAmount: amt,
      paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
      modeOfPayment,
      paymentStatus: status,
      bankName,
      transactionId,
      chequeNumber,
      upiId,
      remark,
    });
    if (typeof order.calculatePaymentTotals === "function") {
      order.calculatePaymentTotals();
    } else {
      const collected = (order.payment || [])
        .filter((p) => String(p.paymentStatus).toUpperCase() === "COLLECTED")
        .reduce((s, p) => s + (Number(p.paidAmount) || 0), 0);
      order.paidAmount = roundMoney(collected);
      order.paymentStatus = paymentStatusFromPaid(Number(order.totalAmount) || 0, order.paidAmount);
    }
    await order.save();
    const savedPayment = order.payment[order.payment.length - 1];

    if (order.merchant && status === "COLLECTED") {
      await Merchant.findByIdAndUpdate(order.merchant, {
        $inc: {
          totalPaidAmount: amt,
          outstandingAmount: -amt,
        },
      });
      await postSellPaymentAr(order, savedPayment, userId);
    }

    return { ok: true, data: { sellOrder: order, payment: savedPayment } };
  }

  if (
    type === "agrisalesorder" ||
    type === "agri_sales_order" ||
    type === "agriorder" ||
    type === "aso"
  ) {
    const order = await AgriSalesOrder.findById(documentId);
    if (!order) return { ok: false, error: "Agri sales order not found", status: 404 };
    if (!order.merchant) {
      return {
        ok: false,
        error: "Order has no merchant — use farmer payment flow on the order",
        status: 400,
      };
    }

    if (!order.payment) order.payment = [];
    order.payment.push({
      paidAmount: amt,
      paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
      modeOfPayment,
      paymentStatus: status,
      bankName,
      transactionId,
      chequeNumber,
      upiId,
      remark,
    });
    // pre-save hook recomputes totalPaidAmount / balance / paymentStatus
    await order.save();
    const savedPayment = order.payment[order.payment.length - 1];

    let ledgerResult = { ok: true, skipped: true };
    if (status === "COLLECTED") {
      ledgerResult = await postAgriSalesPaymentAr(order, savedPayment, userId);
    }

    return {
      ok: true,
      data: { agriSalesOrder: order, payment: savedPayment, ledger: ledgerResult },
    };
  }

  return { ok: false, error: "Unsupported documentType", status: 400 };
}

export async function collectDocumentPayment(opts) {
  return addDocumentPayment({ ...opts, paymentStatus: "COLLECTED" });
}
