/**
 * AP party list: MoneyLedgerEntry balances + purchase parties from approved GRNs
 * so merchants like Dharti appear even when GRN lines were ₹0 stock loads.
 */
import mongoose from "mongoose";
import GRN from "../../models/grn.model.js";
import Merchant from "../../models/merchant.model.js";
import Supplier from "../../models/supplier.model.js";
import { listPartiesWithBalances, roundMoney } from "./postEntry.js";

function bookMatchForItem(book, item) {
  const agri = !!item?.isRamAgriProduct;
  if (book === "RAM_AGRI") return agri;
  return !agri;
}

async function resolveParty(supplierId) {
  if (!supplierId || !mongoose.isValidObjectId(supplierId)) return null;
  const id = String(supplierId);
  const supplier = await Supplier.findById(id).select("name").lean();
  if (supplier) {
    return { partyType: "SUPPLIER", partyId: supplier._id, partyName: supplier.name || "" };
  }
  const merchant = await Merchant.findById(id).select("name").lean();
  if (merchant) {
    return { partyType: "MERCHANT", partyId: merchant._id, partyName: merchant.name || "" };
  }
  return { partyType: "MERCHANT", partyId: id, partyName: "" };
}

/**
 * Distinct suppliers on approved GRNs that have at least one line for this book.
 */
async function listGrnPurchaseParties(book, q = "") {
  const grns = await GRN.find({ status: { $regex: /^approved$/i } })
    .select("supplier items.isRamAgriProduct grnDate updatedAt")
    .lean();

  const byKey = new Map();
  for (const grn of grns) {
    const hasBookLine = (grn.items || []).some((it) => bookMatchForItem(book, it));
    if (!hasBookLine) continue;
    const sid = grn.supplier?._id || grn.supplier;
    if (!sid) continue;
    const key = String(sid);
    const prev = byKey.get(key);
    const ts = grn.grnDate || grn.updatedAt;
    if (!prev || (ts && (!prev.lastEntryAt || new Date(ts) > new Date(prev.lastEntryAt)))) {
      byKey.set(key, { supplierId: sid, lastEntryAt: ts || null });
    }
  }

  const parties = [];
  for (const row of byKey.values()) {
    const party = await resolveParty(row.supplierId);
    if (!party) continue;
    parties.push({
      ...party,
      debit: 0,
      credit: 0,
      balance: 0,
      lastEntryAt: row.lastEntryAt,
      source: "GRN",
    });
  }

  const term = String(q || "").trim().toLowerCase();
  if (!term) return parties;
  return parties.filter(
    (p) =>
      String(p.partyName || "").toLowerCase().includes(term) ||
      String(p.partyId).includes(term)
  );
}

/**
 * AP parties = ledger balances ∪ GRN purchase parties (zero-balance vendors still listed).
 */
export async function listApParties({ book, q = "", limit = 100 } = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 100));
  const [fromLedger, fromGrn] = await Promise.all([
    listPartiesWithBalances({ book, side: "AP", q, limit: lim }),
    listGrnPurchaseParties(book, q),
  ]);

  const map = new Map();
  for (const p of fromGrn) {
    map.set(`${p.partyType}:${p.partyId}`, { ...p });
  }
  for (const p of fromLedger) {
    const key = `${p.partyType}:${p.partyId}`;
    const prev = map.get(key);
    map.set(key, {
      ...(prev || {}),
      ...p,
      partyName: p.partyName || prev?.partyName || "",
      source: "LEDGER",
    });
  }

  let rows = [...map.values()].map((r) => ({
    partyType: r.partyType,
    partyId: r.partyId,
    partyName: r.partyName || "",
    debit: roundMoney(r.debit),
    credit: roundMoney(r.credit),
    balance: roundMoney(r.balance),
    lastEntryAt: r.lastEntryAt || null,
  }));

  rows.sort((a, b) => {
    if (Math.abs(b.balance) !== Math.abs(a.balance)) {
      return Math.abs(b.balance) - Math.abs(a.balance);
    }
    const tb = b.lastEntryAt ? new Date(b.lastEntryAt).getTime() : 0;
    const ta = a.lastEntryAt ? new Date(a.lastEntryAt).getTime() : 0;
    return tb - ta;
  });

  return rows.slice(0, lim);
}
