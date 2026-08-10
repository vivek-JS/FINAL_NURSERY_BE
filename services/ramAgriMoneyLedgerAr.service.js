/**
 * Ram Agri AR parties for Money Ledger: Farmers (customer ledger) + Merchants (B2B MoneyLedgerEntry).
 */
import mongoose from "mongoose";
import RamAgriCustomerLedgerEntry from "../models/ramAgriCustomerLedger.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import Merchant from "../models/merchant.model.js";
import MoneyLedgerEntry from "../models/moneyLedgerEntry.model.js";
import { normalizeAgriCustomerMobile } from "../utils/ramAgriLedgerHelper.js";
import {
  roundMoney as rm,
  listPartiesWithBalances,
  listPartyStatement,
} from "./moneyLedger/postEntry.js";

function paidOnOrder(order) {
  return (order.payment || []).reduce((s, p) => {
    if (String(p.paymentStatus || "").toUpperCase() === "COLLECTED") {
      return s + (Number(p.paidAmount) || 0);
    }
    return s;
  }, 0);
}

function returnCreditOnOrder(order) {
  return (
    Number(order.returnCreditAmount) ||
    Number(order.totalReturnCredit) ||
    Number(order.salesReturnCredit) ||
    0
  );
}

/** Gross sale amount for AR (original bill, or total + returns if total was reduced). */
function grossSaleAmount(order) {
  const orig = Number(order.originalTotalAmount) || 0;
  if (orig > 0) return orig;
  const total = Number(order.totalAmount) || 0;
  const ret = returnCreditOnOrder(order);
  return total + ret;
}

/** Farmer / walk-in customer parties from legacy Ram Agri customer ledger.
 * Excludes mobiles that already belong to a Merchant (B2B) so Dharti etc. are merchant-only.
 */
export async function listRamAgriFarmerParties({ q = "", limit = 100 } = {}) {
  const merchantPhones = await Merchant.find({ isActive: { $ne: false } })
    .select("phone")
    .lean();
  const excludeMobiles = new Set(
    merchantPhones
      .map((m) => normalizeAgriCustomerMobile(m.phone))
      .filter((p) => p && p.length >= 10 && !/^0+$/.test(p))
  );

  const match = {};
  if (q) {
    const mobile = normalizeAgriCustomerMobile(q);
    match.$or = [
      { customerMobile: { $regex: mobile || q, $options: "i" } },
      { customerName: { $regex: q, $options: "i" } },
    ];
  }
  const agg = await RamAgriCustomerLedgerEntry.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$customerMobile",
        partyName: { $last: "$customerName" },
        debit: { $sum: "$debit" },
        credit: { $sum: "$credit" },
        lastEntryAt: { $max: "$entryDate" },
      },
    },
    { $addFields: { balance: { $subtract: ["$debit", "$credit"] } } },
    { $sort: { balance: -1 } },
    { $limit: Math.min(200, Number(limit) || 100) },
  ]);

  return agg
    .filter((r) => {
      const mob = normalizeAgriCustomerMobile(r._id);
      return !excludeMobiles.has(mob);
    })
    .map((r) => ({
      partyType: "CUSTOMER",
      partyKind: "FARMER",
      partyId: r._id,
      partyKey: r._id,
      partyName: r.partyName || "",
      debit: rm(r.debit),
      credit: rm(r.credit),
      balance: rm(r.balance),
      lastEntryAt: r.lastEntryAt,
    }));
}

/** B2B merchant receivables from durable MoneyLedgerEntry (fallback: agri orders). */
export async function listRamAgriMerchantArParties({ q = "", limit = 100 } = {}) {
  const ledgerRows = await listPartiesWithBalances({
    book: "RAM_AGRI",
    side: "AR",
    q,
    limit: Math.min(200, Number(limit) || 100) * 2,
  });
  const fromLedger = ledgerRows
    .filter((r) => String(r.partyType).toUpperCase() === "MERCHANT")
    .map((r) => ({
      partyType: "MERCHANT",
      partyKind: "MERCHANT",
      partyId: String(r.partyId),
      partyKey: String(r.partyId),
      partyName: r.partyName || "",
      debit: rm(r.debit),
      credit: rm(r.credit),
      balance: rm(r.balance),
      lastEntryAt: r.lastEntryAt,
    }));

  if (fromLedger.length) {
    fromLedger.sort((a, b) => b.balance - a.balance);
    return fromLedger.slice(0, Math.min(200, Number(limit) || 100));
  }

  // Fallback until sell backfill runs
  const match = {
    merchant: { $ne: null },
    orderStatus: { $ne: "CANCELLED" },
  };

  const orders = await AgriSalesOrder.find(match)
    .select(
      "merchant totalAmount originalTotalAmount payment orderStatus orderDate createdAt returnCreditAmount"
    )
    .lean();

  const byMerchant = new Map();
  for (const o of orders) {
    const mid = String(o.merchant);
    if (!byMerchant.has(mid)) {
      byMerchant.set(mid, {
        partyId: o.merchant,
        debit: 0,
        credit: 0,
        lastEntryAt: o.orderDate || o.createdAt,
      });
    }
    const row = byMerchant.get(mid);
    const total = grossSaleAmount(o);
    const paid = paidOnOrder(o);
    const ret = returnCreditOnOrder(o);
    row.debit += total;
    row.credit += paid + ret;
    const ts = o.orderDate || o.createdAt;
    if (ts && (!row.lastEntryAt || new Date(ts) > new Date(row.lastEntryAt))) {
      row.lastEntryAt = ts;
    }
  }

  let merchants = [];
  if (byMerchant.size) {
    const ids = [...byMerchant.keys()].map((id) => new mongoose.Types.ObjectId(id));
    const filter = { _id: { $in: ids } };
    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { phone: { $regex: q, $options: "i" } },
        { code: { $regex: q, $options: "i" } },
      ];
    }
    const docs = await Merchant.find(filter).select("name phone code").lean();
    merchants = docs.map((m) => {
      const row = byMerchant.get(String(m._id)) || { debit: 0, credit: 0 };
      return {
        partyType: "MERCHANT",
        partyKind: "MERCHANT",
        partyId: String(m._id),
        partyKey: String(m._id),
        partyName: m.name || "",
        phone: m.phone || "",
        debit: rm(row.debit),
        credit: rm(row.credit),
        balance: rm(row.debit - row.credit),
        lastEntryAt: row.lastEntryAt,
      };
    });
  }

  merchants.sort((a, b) => b.balance - a.balance);
  return merchants.slice(0, Math.min(200, Number(limit) || 100));
}

export async function listRamAgriArParties({ partyKind = "ALL", q = "", limit = 100 } = {}) {
  const kind = String(partyKind || "ALL").toUpperCase();
  if (kind === "FARMER" || kind === "CUSTOMER") {
    return listRamAgriFarmerParties({ q, limit });
  }
  if (kind === "MERCHANT") {
    return listRamAgriMerchantArParties({ q, limit });
  }
  const [farmers, merchants] = await Promise.all([
    listRamAgriFarmerParties({ q, limit }),
    listRamAgriMerchantArParties({ q, limit }),
  ]);
  return [...merchants, ...farmers]
    .sort((a, b) => b.balance - a.balance)
    .slice(0, Math.min(200, Number(limit) || 100));
}

export async function getRamAgriFarmerStatement(partyId, { limit = 500 } = {}) {
  const mobile = normalizeAgriCustomerMobile(partyId) || String(partyId);
  const entries = await RamAgriCustomerLedgerEntry.find({ customerMobile: mobile })
    .sort({ entryDate: 1, createdAt: 1 })
    .limit(Math.min(1000, Number(limit) || 500))
    .lean();
  let running = 0;
  const chronological = entries.map((e) => {
    running = rm(running + (Number(e.debit) || 0) - (Number(e.credit) || 0));
    return {
      ...e,
      book: "RAM_AGRI",
      side: "AR",
      partyType: "CUSTOMER",
      partyId: mobile,
      refType: e.entryType || e.refType || "SELL",
      documentNumber: e.reference,
      runningBalance: running,
    };
  });
  const rows = chronological.slice().reverse();
  return {
    party: {
      book: "RAM_AGRI",
      side: "AR",
      partyType: "CUSTOMER",
      partyKind: "FARMER",
      partyId: mobile,
      partyName: entries[entries.length - 1]?.customerName || "",
    },
    entries: rows,
    totals: {
      debit: rm(entries.reduce((s, e) => s + (Number(e.debit) || 0), 0)),
      credit: rm(entries.reduce((s, e) => s + (Number(e.credit) || 0), 0)),
      closing: running,
    },
  };
}

/** Merchant B2B AR statement from MoneyLedgerEntry (SELL / PAYMENT / SALES_RETURN / REVERSAL). */
export async function getRamAgriMerchantArStatement(merchantId, { limit = 500 } = {}) {
  if (!mongoose.isValidObjectId(merchantId)) {
    return { ok: false, error: "Valid merchant id required", status: 400 };
  }
  const merchant = await Merchant.findById(merchantId).select("name phone code").lean();
  if (!merchant) return { ok: false, error: "Merchant not found", status: 404 };

  const durableCount = await MoneyLedgerEntry.countDocuments({
    book: "RAM_AGRI",
    side: "AR",
    partyType: "MERCHANT",
    partyId: merchantId,
  });

  if (durableCount > 0) {
    const { entries, totals } = await listPartyStatement({
      book: "RAM_AGRI",
      side: "AR",
      partyType: "MERCHANT",
      partyId: merchantId,
      limit,
    });
    let running = 0;
    const rows = entries.map((e) => {
      running = rm(running + (Number(e.debit) || 0) - (Number(e.credit) || 0));
      return {
        ...e,
        book: "RAM_AGRI",
        side: "AR",
        partyKind: "MERCHANT",
        runningBalance: running,
      };
    });
    return {
      ok: true,
      party: {
        book: "RAM_AGRI",
        side: "AR",
        partyType: "MERCHANT",
        partyKind: "MERCHANT",
        partyId: String(merchantId),
        partyName: merchant.name || "",
      },
      entries: rows,
      totals: {
        debit: rm(totals.debit),
        credit: rm(totals.credit),
        closing: running,
      },
    };
  }

  const orders = await AgriSalesOrder.find({
    merchant: merchantId,
    orderStatus: { $ne: "CANCELLED" },
  })
    .select(
      "orderNumber orderDate createdAt updatedAt totalAmount originalTotalAmount payment returnCreditAmount"
    )
    .sort({ orderDate: 1, createdAt: 1 })
    .limit(Math.min(500, Number(limit) || 500))
    .lean();

  const lines = [];
  for (const o of orders) {
    const total = grossSaleAmount(o);
    if (total > 0) {
      lines.push({
        entryDate: o.orderDate || o.createdAt,
        refType: "SELL",
        documentType: "AgriSalesOrder",
        documentId: o._id,
        documentNumber: o.orderNumber,
        description: `B2B sale ${o.orderNumber || ""}`.trim(),
        debit: total,
        credit: 0,
        partyType: "MERCHANT",
        partyId: String(merchantId),
        partyName: merchant.name,
      });
    }
    for (const p of o.payment || []) {
      if (String(p.paymentStatus || "").toUpperCase() !== "COLLECTED") continue;
      const amt = Number(p.paidAmount) || 0;
      if (amt <= 0) continue;
      lines.push({
        entryDate: p.paymentDate || o.orderDate || o.createdAt,
        refType: "PAYMENT",
        documentType: "AgriSalesOrder",
        documentId: o._id,
        documentNumber: o.orderNumber,
        description: `Payment ${p.modeOfPayment || ""}`.trim(),
        debit: 0,
        credit: amt,
        partyType: "MERCHANT",
        partyId: String(merchantId),
        partyName: merchant.name,
      });
    }
    const ret = returnCreditOnOrder(o);
    if (ret > 0) {
      lines.push({
        entryDate: o.updatedAt || o.orderDate || o.createdAt,
        refType: "SALES_RETURN",
        documentType: "AgriSalesOrder",
        documentId: o._id,
        documentNumber: o.orderNumber,
        description: `Sale return credit ${o.orderNumber || ""}`.trim(),
        debit: 0,
        credit: ret,
        partyType: "MERCHANT",
        partyId: String(merchantId),
        partyName: merchant.name,
      });
    }
  }

  lines.sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));
  let running = 0;
  const entries = lines.map((e) => {
    running = rm(running + (Number(e.debit) || 0) - (Number(e.credit) || 0));
    return { ...e, book: "RAM_AGRI", side: "AR", runningBalance: running };
  });

  return {
    ok: true,
    party: {
      book: "RAM_AGRI",
      side: "AR",
      partyType: "MERCHANT",
      partyKind: "MERCHANT",
      partyId: String(merchantId),
      partyName: merchant.name || "",
    },
    entries,
    totals: {
      debit: rm(entries.reduce((s, e) => s + (Number(e.debit) || 0), 0)),
      credit: rm(entries.reduce((s, e) => s + (Number(e.credit) || 0), 0)),
      closing: running,
    },
  };
}
