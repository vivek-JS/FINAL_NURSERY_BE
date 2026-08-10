import mongoose from "mongoose";
import MoneyLedgerEntry from "../../models/moneyLedgerEntry.model.js";
import MerchantSellOrder from "../../models/sellOrder.model.js";
import PurchaseOrder from "../../models/purchaseOrder.model.js";
import GRN from "../../models/grn.model.js";
import PurchaseReturn from "../../models/purchaseReturn.model.js";
import AgriSalesOrder from "../../models/agriSalesOrder.model.js";
import RamAgriCustomerLedgerEntry from "../../models/ramAgriCustomerLedger.model.js";
import { postEntry, roundMoney } from "./postEntry.js";
import { postPurchaseFromGrn, postPurchaseReturnAp, syncSupplierOutstanding } from "./purchasePosts.js";
import { postSellOrderAr } from "./sellPosts.js";
import AgriSalesReturnRequest from "../../models/agriSalesReturnRequest.model.js";
import { postAgriCustomerEntry, normalizeAgriCustomerMobile } from "./agriAdapter.js";
import Merchant from "../../models/merchant.model.js";
import Supplier from "../../models/supplier.model.js";
import { postAgriSalesReturnLedgers, applyOrderReturnCreditFields } from "../salesReturnLedger.service.js";
import { postAgriSalesOrderAr } from "./agriSellPosts.js";

async function resolveApParty(supplierId) {
  if (!supplierId) return null;
  const s = await Supplier.findById(supplierId).select("name").lean();
  if (s) return { partyType: "SUPPLIER", partyId: s._id, partyName: s.name || "" };
  const m = await Merchant.findById(supplierId).select("name").lean();
  if (m) return { partyType: "MERCHANT", partyId: m._id, partyName: m.name || "" };
  return { partyType: "SUPPLIER", partyId: supplierId, partyName: "" };
}

/**
 * Idempotent historical backfill for money ledger.
 */
export async function runMoneyLedgerBackfill({ dryRun = false, limit = 0 } = {}) {
  const stats = {
    sellOrders: 0,
    sellOrderPayments: 0,
    grns: 0,
    poPayments: 0,
    purchaseReturns: 0,
    agriCustomerOrders: 0,
    agriCustomerPayments: 0,
    agriMerchantOrders: 0,
    agriMerchantPayments: 0,
    agriSalesReturns: 0,
    errors: [],
  };

  // 1) Classic sell orders
  const sellQ = MerchantSellOrder.find({}).sort({ createdAt: 1 });
  if (limit > 0) sellQ.limit(limit);
  const sells = await sellQ;
  for (const so of sells) {
    try {
      if (dryRun) {
        stats.sellOrders += 1;
        continue;
      }
      const r = await postSellOrderAr(so, so.createdBy);
      if (r?.ok && !r.skipped) {
        stats.sellOrders += 1;
        stats.sellOrderPayments += (r.paymentResults || []).filter((x) => x?.created).length;
      }
    } catch (e) {
      stats.errors.push(`sell ${so._id}: ${e.message}`);
    }
  }

  // 2) Approved GRNs → purchase AP (case-insensitive status)
  const grnQ = GRN.find({
    status: { $regex: /^approved$/i },
  }).sort({ createdAt: 1 });
  if (limit > 0) grnQ.limit(limit);
  const grns = await grnQ;
  for (const grn of grns) {
    try {
      if (dryRun) {
        stats.grns += 1;
        continue;
      }
      const r = await postPurchaseFromGrn(grn, grn.updatedBy || grn.createdBy);
      if (r?.ok) stats.grns += 1;
    } catch (e) {
      stats.errors.push(`grn ${grn._id}: ${e.message}`);
    }
  }

  // 3) PO embedded payments (synthetic if only paidAmount) — book from PO line mix
  const pos = await PurchaseOrder.find({
    $or: [{ paidAmount: { $gt: 0 } }, { "payments.0": { $exists: true } }],
  }).limit(limit > 0 ? limit : 10000);
  for (const po of pos) {
    try {
      const party = await resolveApParty(po.supplier);
      if (!party) continue;

      let agriLine = 0;
      let classicLine = 0;
      for (const it of po.items || []) {
        const lineAmt = roundMoney(Number(it.amount) || (Number(it.quantity) || 0) * (Number(it.rate) || 0));
        if (it.isRamAgriProduct) agriLine = roundMoney(agriLine + lineAmt);
        else classicLine = roundMoney(classicLine + lineAmt);
      }
      const lineSum = roundMoney(agriLine + classicLine);
      /** book → share of a payment (1.0 for single-book POs) */
      const bookShares = [];
      if (lineSum <= 0) {
        bookShares.push({ book: "BIOTECH", share: 1 });
      } else if (agriLine > 0 && classicLine <= 0) {
        bookShares.push({ book: "RAM_AGRI", share: 1 });
      } else if (classicLine > 0 && agriLine <= 0) {
        bookShares.push({ book: "BIOTECH", share: 1 });
      } else {
        bookShares.push({ book: "BIOTECH", share: classicLine / lineSum });
        bookShares.push({ book: "RAM_AGRI", share: agriLine / lineSum });
      }

      const payments =
        po.payments?.length > 0
          ? po.payments
          : po.paidAmount > 0
            ? [
                {
                  _id: po._id,
                  paidAmount: po.paidAmount,
                  paymentDate: po.updatedAt || po.poDate || po.createdAt,
                  paymentStatus: "COLLECTED",
                  modeOfPayment: "Cash",
                  _synthetic: true,
                },
              ]
            : [];

      for (const p of payments) {
        if (String(p.paymentStatus || "COLLECTED").toUpperCase() !== "COLLECTED") continue;
        const amt = roundMoney(p.paidAmount);
        if (amt <= 0) continue;
        if (dryRun) {
          stats.poPayments += 1;
          continue;
        }
        for (const { book, share } of bookShares) {
          const bookAmt = roundMoney(amt * share);
          if (bookAmt <= 0) continue;
          const key = p._synthetic
            ? `${book.toLowerCase()}:ap:po:${po._id}:payment:synthetic_paid`
            : `${book.toLowerCase()}:ap:po:${po._id}:payment:${p._id}`;
          await postEntry({
            book,
            side: "AP",
            partyType: party.partyType,
            partyId: party.partyId,
            partyName: party.partyName,
            entryDate: p.paymentDate || po.poDate || po.updatedAt || new Date(),
            refType: "PAYMENT",
            documentType: "PurchaseOrder",
            documentId: po._id,
            documentNumber: po.poNumber || "",
            paymentId: p._synthetic ? undefined : p._id,
            debit: bookAmt,
            description: `Backfill supplier payment on ${po.poNumber || ""}`,
            reference: po.poNumber || "",
            idempotencyKey: key,
            createdBy: po.createdBy,
            metadata: { backfill: true, synthetic: !!p._synthetic },
          });
        }
        stats.poPayments += 1;
      }
      if (!dryRun) await syncSupplierOutstanding(party.partyType, party.partyId);
    } catch (e) {
      stats.errors.push(`po ${po._id}: ${e.message}`);
    }
  }

  // 3b) POs received / partial with amount but no approved GRN ledger yet → use PO date
  const receivedPos = await PurchaseOrder.find({
    status: { $in: ["received", "partial_received", "RECEIVED", "PARTIAL_RECEIVED"] },
    "items.0": { $exists: true },
  })
    .limit(limit > 0 ? limit : 10000)
    .lean();

  for (const po of receivedPos) {
    try {
      const party = await resolveApParty(po.supplier);
      if (!party) continue;
      let classicTotal = 0;
      let agriTotal = 0;
      for (const item of po.items || []) {
        const qty = Number(item.receivedQuantity ?? item.quantity) || 0;
        if (qty <= 0) continue;
        const rate = Number(item.rate) || 0;
        const amt = roundMoney(Number(item.amount) || qty * rate);
        if (item.isRamAgriProduct) agriTotal = roundMoney(agriTotal + amt);
        else classicTotal = roundMoney(classicTotal + amt);
      }
      if (classicTotal <= 0 && agriTotal <= 0) continue;

      // Skip if a GRN already covers this PO in ledger
      const hasGrnLedger = await MoneyLedgerEntry.exists({
        documentType: "GRN",
        refType: "PURCHASE",
        "metadata.purchaseOrderId": po._id,
      });
      if (hasGrnLedger) continue;

      if (dryRun) {
        stats.grns += 1;
        continue;
      }

      const entryDate = po.poDate || po.updatedAt || po.createdAt || new Date();
      if (classicTotal > 0) {
        await postEntry({
          book: "BIOTECH",
          side: "AP",
          partyType: party.partyType,
          partyId: party.partyId,
          partyName: party.partyName,
          entryDate,
          refType: "PURCHASE",
          documentType: "PurchaseOrder",
          documentId: po._id,
          documentNumber: po.poNumber || "",
          credit: classicTotal,
          description: `Backfill purchase (classic) PO ${po.poNumber || ""}`,
          reference: po.poNumber || "",
          idempotencyKey: `biotech:ap:po:${po._id}:purchase:classic`,
          createdBy: po.createdBy,
          metadata: { backfill: true, source: "PO_WITHOUT_GRN_LEDGER" },
        });
      }
      if (agriTotal > 0) {
        await postEntry({
          book: "RAM_AGRI",
          side: "AP",
          partyType: party.partyType,
          partyId: party.partyId,
          partyName: party.partyName,
          entryDate,
          refType: "PURCHASE",
          documentType: "PurchaseOrder",
          documentId: po._id,
          documentNumber: po.poNumber || "",
          credit: agriTotal,
          description: `Backfill purchase (Ram Agri) PO ${po.poNumber || ""}`,
          reference: po.poNumber || "",
          idempotencyKey: `ram_agri:ap:po:${po._id}:purchase:agri`,
          createdBy: po.createdBy,
          metadata: { backfill: true, source: "PO_WITHOUT_GRN_LEDGER" },
        });
      }
      stats.grns += 1;
      await syncSupplierOutstanding(party.partyType, party.partyId);
    } catch (e) {
      stats.errors.push(`po-purchase ${po._id}: ${e.message}`);
    }
  }
  // 4) Purchase returns — heal stock-done / ledger-missing (idempotent)
  const prs = await PurchaseReturn.find({ status: "COMPLETED" }).limit(limit > 0 ? limit : 10000);
  for (const pr of prs) {
    try {
      if (dryRun) {
        stats.purchaseReturns += 1;
        continue;
      }
      const already = await MoneyLedgerEntry.exists({
        documentType: "PurchaseReturn",
        documentId: pr._id,
        refType: "PURCHASE_RETURN",
      });
      if (already) {
        if (pr.ledgerStatus !== "POSTED" && pr.ledgerStatus !== "SKIPPED") {
          pr.ledgerStatus = Number(pr.totalAmount) > 0 ? "POSTED" : "SKIPPED";
          pr.ledgerError = "";
          await pr.save();
        }
        continue;
      }
      const r = await postPurchaseReturnAp(pr, pr.createdBy);
      if (r?.skipped) {
        pr.ledgerStatus = "SKIPPED";
        pr.ledgerError = "";
        await pr.save();
        stats.purchaseReturns += 1;
      } else if (r?.ok) {
        pr.ledgerStatus = "POSTED";
        pr.ledgerError = "";
        await pr.save();
        stats.purchaseReturns += 1;
      } else {
        pr.ledgerStatus = "FAILED";
        pr.ledgerError = r?.error || "backfill failed";
        await pr.save();
        stats.errors.push(`pr ${pr._id}: ${r?.error || "failed"}`);
      }
    } catch (e) {
      stats.errors.push(`pr ${pr._id}: ${e.message}`);
    }
  }

  // 5) Agri customer — missing ORDER/PAYMENT with idempotency (no GET-time insertMany)
  const agriOrders = await AgriSalesOrder.find({})
    .select(
      "orderNumber customerMobile customerName totalAmount orderDate payment paymentStatus createdBy"
    )
    .limit(limit > 0 ? limit : 20000)
    .lean();

  for (const ao of agriOrders) {
    try {
      const mobile = normalizeAgriCustomerMobile(ao.customerMobile || ao.customer?.mobile);
      if (!mobile) continue;
      const orderKey = `ram_agri:ar:order:${ao._id}`;
      const hasOrder = await RamAgriCustomerLedgerEntry.exists({
        "metadata.idempotencyKey": orderKey,
      });
      // also detect legacy order rows without key
      const legacyOrder = await RamAgriCustomerLedgerEntry.exists({
        orderId: ao._id,
        refType: "ORDER",
      });
      if (!hasOrder && !legacyOrder && Number(ao.totalAmount) > 0) {
        if (!dryRun) {
          await postAgriCustomerEntry({
            customerMobile: mobile,
            customerName: ao.customerName || "",
            refType: "ORDER",
            orderId: ao._id,
            debit: ao.totalAmount,
            reference: ao.orderNumber,
            description: `Backfill order ${ao.orderNumber}`,
            entryDate: ao.orderDate || ao.createdAt,
            createdBy: ao.createdBy,
            idempotencyKey: orderKey,
            metadata: { backfill: true },
          });
        }
        stats.agriCustomerOrders += 1;
      }

      for (const p of ao.payment || []) {
        if (String(p.paymentStatus).toUpperCase() !== "COLLECTED") continue;
        const pid = p._id;
        const payKey = `ram_agri:ar:order:${ao._id}:payment:${pid}`;
        const hasPay =
          (await RamAgriCustomerLedgerEntry.exists({ "metadata.idempotencyKey": payKey })) ||
          (await RamAgriCustomerLedgerEntry.exists({
            orderId: ao._id,
            paymentId: pid,
            refType: "PAYMENT",
          }));
        if (hasPay) continue;
        if (!dryRun) {
          await postAgriCustomerEntry({
            customerMobile: mobile,
            customerName: ao.customerName || "",
            refType: "PAYMENT",
            orderId: ao._id,
            paymentId: pid,
            credit: p.paidAmount,
            reference: ao.orderNumber,
            description: `Backfill payment on ${ao.orderNumber}`,
            entryDate: p.paymentDate || new Date(),
            createdBy: ao.createdBy,
            idempotencyKey: payKey,
            metadata: { backfill: true },
          });
        }
        stats.agriCustomerPayments += 1;
      }
    } catch (e) {
      stats.errors.push(`agri ${ao._id}: ${e.message}`);
    }
  }

  // 5b) Agri B2B merchant orders → MoneyLedgerEntry RAM_AGRI AR SELL + PAYMENT
  const agriMerchantOrders = await AgriSalesOrder.find({
    merchant: { $ne: null },
    orderStatus: { $ne: "CANCELLED" },
    totalAmount: { $gt: 0 },
  })
    .select(
      "orderNumber merchant customerName totalAmount originalTotalAmount orderDate payment createdBy createdAt"
    )
    .limit(limit > 0 ? limit : 20000)
    .lean();

  for (const ao of agriMerchantOrders) {
    try {
      if (dryRun) {
        stats.agriMerchantOrders += 1;
        continue;
      }
      const before = await MoneyLedgerEntry.countDocuments({
        book: "RAM_AGRI",
        side: "AR",
        documentType: "AgriSalesOrder",
        documentId: ao._id,
        refType: { $in: ["SELL", "PAYMENT"] },
      });
      const r = await postAgriSalesOrderAr(ao, ao.createdBy);
      if (!r?.ok) {
        stats.errors.push(`agriMerchant ${ao._id}: ${r?.error || "failed"}`);
        continue;
      }
      const after = await MoneyLedgerEntry.countDocuments({
        book: "RAM_AGRI",
        side: "AR",
        documentType: "AgriSalesOrder",
        documentId: ao._id,
        refType: { $in: ["SELL", "PAYMENT"] },
      });
      if (after > before) {
        stats.agriMerchantOrders += 1;
        stats.agriMerchantPayments += Math.max(0, after - before - 1);
      }
    } catch (e) {
      stats.errors.push(`agriMerchant ${ao._id}: ${e.message}`);
    }
  }

  // 6) Agri sales returns (approved requests) → customer + money ledger
  const returnReqs = await AgriSalesReturnRequest.find({
    status: "APPROVED",
    creditAmount: { $gt: 0 },
  })
    .limit(limit > 0 ? limit : 10000)
    .lean();

  for (const rr of returnReqs) {
    try {
      if (dryRun) {
        stats.agriSalesReturns += 1;
        continue;
      }
      const order = await AgriSalesOrder.findById(rr.orderId);
      if (!order) continue;
      const credit = Number(rr.creditAmount) || 0;
      if (!(credit > 0)) continue;

      applyOrderReturnCreditFields(order, 0); // no-op if 0; ensure fields exist
      if (!(Number(order.returnCreditAmount) > 0) && credit > 0) {
        if (!(Number(order.originalTotalAmount) > 0)) {
          order.originalTotalAmount = roundMoney(
            (Number(order.totalAmount) || 0) + credit
          );
        }
        order.returnCreditAmount = roundMoney(
          (Number(order.returnCreditAmount) || 0) + credit
        );
        await order.save();
      }

      const key = rr.merchantBatchGroupId
        ? `ram_agri:ar:sales_return:merchant_batch:${rr.merchantBatchGroupId}:order:${order._id}`
        : `ram_agri:ar:sales_return:request:${rr._id}`;

      const r = await postAgriSalesReturnLedgers({
        order,
        creditAmount: credit,
        userId: rr.reviewedBy || rr.createdBy || order.createdBy,
        refId: rr._id,
        idempotencyKey: key,
        description: `Backfill sales return ${order.orderNumber || ""}`,
        metadata: { backfill: true, returnRequestId: rr._id },
        entryDate: rr.reviewedAt || rr.updatedAt || rr.createdAt,
      });
      if (r?.ok) {
        if (order.salesReturnLedgerStatus !== "POSTED") {
          order.salesReturnLedgerStatus = r.skipped ? "SKIPPED" : "POSTED";
          order.salesReturnLedgerError = "";
          await order.save();
        }
        stats.agriSalesReturns += 1;
      } else if (r && !r.ok) {
        stats.errors.push(`salesReturn ${rr._id}: ${r.error || "failed"}`);
      }
    } catch (e) {
      stats.errors.push(`salesReturn ${rr._id}: ${e.message}`);
    }
  }

  const totalLines = await MoneyLedgerEntry.countDocuments();
  return { ok: true, dryRun, stats, moneyLedgerEntryCount: totalLines };
}
