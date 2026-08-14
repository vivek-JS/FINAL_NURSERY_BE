/**
 * Unified party ledger per book: AR + AP lines merged (Tally-style debit/credit).
 * Balance = debit − credit (>0 they owe us, <0 we owe them).
 * Biotech Master and Ram Agri Input are separate books.
 */
import mongoose from "mongoose";
import MoneyLedgerEntry from "../../models/moneyLedgerEntry.model.js";
import Merchant from "../../models/merchant.model.js";
import Supplier from "../../models/supplier.model.js";
import { roundMoney } from "./postEntry.js";
import { listRamAgriFarmerParties, getRamAgriFarmerStatement } from "../ramAgriMoneyLedgerAr.service.js";
import { enrichStatementProducts } from "./enrichStatementProducts.js";
import { ledgerEntrySortTime } from "../../utility/istLedgerDate.js";

const BOOKS = new Set(["BIOTECH", "RAM_AGRI"]);

/**
 * Parties for one money-ledger book (both AR+AP sides merged).
 */
export async function listUnifiedBookParties({
  book = "RAM_AGRI",
  q = "",
  limit = 100,
  partyKind = "ALL",
} = {}) {
  const b = String(book || "RAM_AGRI").toUpperCase();
  if (!BOOKS.has(b)) return [];

  const kind = String(partyKind || "ALL").toUpperCase();
  const lim = Math.min(200, Math.max(1, Number(limit) || 100));

  // Farmers only exist on Ram Agri customer collection
  if (b === "RAM_AGRI" && (kind === "FARMER" || kind === "CUSTOMER")) {
    return listRamAgriFarmerParties({ q, limit: lim });
  }

  const rows = await MoneyLedgerEntry.aggregate([
    { $match: { book: b } },
    {
      $group: {
        _id: { partyType: "$partyType", partyId: "$partyId" },
        partyName: { $last: "$partyName" },
        debit: { $sum: "$debit" },
        credit: { $sum: "$credit" },
        lastEntryAt: { $max: "$entryDate" },
      },
    },
    {
      $addFields: {
        balance: { $subtract: ["$debit", "$credit"] },
      },
    },
    { $sort: { balance: -1, lastEntryAt: -1 } },
  ]);

  let parties = rows
    .filter((r) => {
      const pt = String(r._id.partyType || "").toUpperCase();
      if (kind === "MERCHANT") return pt === "MERCHANT";
      if (kind === "SUPPLIER") return pt === "SUPPLIER";
      // Biotech has no farmers tab in money ledger
      return pt === "MERCHANT" || pt === "SUPPLIER";
    })
    .map((r) => ({
      partyType: r._id.partyType,
      partyId: String(r._id.partyId),
      partyKey: String(r._id.partyId),
      partyName: r.partyName || "",
      partyKind: String(r._id.partyType).toUpperCase() === "MERCHANT" ? "MERCHANT" : "SUPPLIER",
      book: b,
      debit: roundMoney(r.debit),
      credit: roundMoney(r.credit),
      balance: roundMoney(r.balance),
      lastEntryAt: r.lastEntryAt,
      unified: true,
    }));

  const term = String(q || "").trim().toLowerCase();
  if (term) {
    parties = parties.filter(
      (p) =>
        String(p.partyName || "").toLowerCase().includes(term) ||
        String(p.partyId).includes(term)
    );
  }

  if (b === "RAM_AGRI" && kind === "ALL") {
    const farmers = await listRamAgriFarmerParties({ q, limit: lim });
    parties = [...parties, ...farmers].sort((a, b2) => Math.abs(b2.balance) - Math.abs(a.balance));
  }

  return parties.slice(0, lim);
}

export async function listRamAgriUnifiedParties(opts = {}) {
  return listUnifiedBookParties({ ...opts, book: "RAM_AGRI" });
}

/**
 * Unified debit/credit statement for one party in one book.
 */
export async function getUnifiedBookPartyStatement(
  book,
  partyType,
  partyId,
  { limit = 500 } = {}
) {
  const b = String(book || "RAM_AGRI").toUpperCase();
  if (!BOOKS.has(b)) {
    return { ok: false, error: "Invalid book", status: 400 };
  }

  const pt = String(partyType || "").toUpperCase();
  if (b === "RAM_AGRI" && (pt === "CUSTOMER" || pt === "FARMER")) {
    return getRamAgriFarmerStatement(partyId, { limit });
  }

  if (!mongoose.isValidObjectId(partyId)) {
    return { ok: false, error: "Valid party id required", status: 400 };
  }

  let partyName = "";
  if (pt === "MERCHANT") {
    const m = await Merchant.findById(partyId).select("name").lean();
    if (!m) return { ok: false, error: "Merchant not found", status: 404 };
    partyName = m.name || "";
  } else if (pt === "SUPPLIER") {
    const s = await Supplier.findById(partyId).select("name").lean();
    if (!s) return { ok: false, error: "Supplier not found", status: 404 };
    partyName = s.name || "";
  } else {
    return { ok: false, error: "Unsupported partyType", status: 400 };
  }

  const lim = Math.min(2000, Number(limit) || 500);
  const rawEntries = await MoneyLedgerEntry.find({
    book: b,
    partyType: pt,
    partyId,
  })
    .limit(lim)
    .lean();

  rawEntries.sort((a, b2) => {
    const d = ledgerEntrySortTime(a) - ledgerEntrySortTime(b2);
    if (d !== 0) return d;
    return String(a._id || "").localeCompare(String(b2._id || ""));
  });

  const enriched = await enrichStatementProducts(rawEntries);

  // Running balance oldest → newest, then reverse so latest entry is first
  let running = 0;
  const chronological = enriched.map((e) => {
    running = roundMoney(running + (Number(e.debit) || 0) - (Number(e.credit) || 0));
    return {
      ...e,
      book: b,
      runningBalance: running,
      sortTime: ledgerEntrySortTime(e),
    };
  });
  const rows = chronological.slice().reverse();

  const debit = roundMoney(chronological.reduce((s, e) => s + (Number(e.debit) || 0), 0));
  const credit = roundMoney(chronological.reduce((s, e) => s + (Number(e.credit) || 0), 0));

  return {
    ok: true,
    party: {
      book: b,
      side: "ALL",
      partyType: pt,
      partyId: String(partyId),
      partyName,
      unified: true,
    },
    entries: rows,
    totals: {
      debit,
      credit,
      closing: running,
      balance: running,
    },
  };
}

export async function getRamAgriUnifiedPartyStatement(partyType, partyId, opts = {}) {
  return getUnifiedBookPartyStatement("RAM_AGRI", partyType, partyId, opts);
}
