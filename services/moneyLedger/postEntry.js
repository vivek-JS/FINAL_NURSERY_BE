import mongoose from "mongoose";
import MoneyLedgerEntry from "../../models/moneyLedgerEntry.model.js";
import { normalizeLedgerEntryDate } from "../../utility/istLedgerDate.js";

export function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Post an append-only MoneyLedgerEntry. Safe to retry with same idempotencyKey.
 * @returns {{ ok: true, entry, created: boolean } | { ok: false, error, status }}
 */
export async function postEntry({
  book,
  side,
  partyType,
  partyId,
  partyName = "",
  partyKey = "",
  entryDate,
  refType,
  refId,
  documentType = "Other",
  documentId,
  documentNumber = "",
  paymentId,
  debit = 0,
  credit = 0,
  description = "",
  reference = "",
  idempotencyKey,
  createdBy,
  metadata = {},
  session,
} = {}) {
  if (!idempotencyKey) {
    return { ok: false, error: "idempotencyKey is required", status: 400 };
  }
  if (!["BIOTECH", "RAM_AGRI"].includes(book)) {
    return { ok: false, error: "Invalid book", status: 400 };
  }
  if (!["AR", "AP"].includes(side)) {
    return { ok: false, error: "Invalid side", status: 400 };
  }
  if (!partyType || !partyId) {
    return { ok: false, error: "partyType and partyId are required", status: 400 };
  }

  const d = roundMoney(Math.abs(Number(debit) || 0));
  const c = roundMoney(Math.abs(Number(credit) || 0));
  if (d <= 0 && c <= 0) {
    return { ok: false, error: "debit or credit must be > 0", status: 400 };
  }
  if (d > 0 && c > 0) {
    return { ok: false, error: "Cannot set both debit and credit", status: 400 };
  }

  const existing = await MoneyLedgerEntry.findOne({ idempotencyKey })
    .session(session || null)
    .lean();
  if (existing) {
    return { ok: true, entry: existing, created: false };
  }

  const payload = {
    book,
    side,
    partyType,
    partyId,
    partyName: String(partyName || "").trim(),
    partyKey: String(partyKey || partyId || "").trim(),
    entryDate: normalizeLedgerEntryDate(entryDate),
    refType,
    refId: refId || documentId || undefined,
    documentType,
    documentId: documentId || undefined,
    documentNumber: String(documentNumber || "").trim(),
    paymentId: paymentId || undefined,
    debit: d,
    credit: c,
    description: String(description || "").trim(),
    reference: String(reference || "").trim(),
    idempotencyKey: String(idempotencyKey).trim(),
    createdBy: createdBy || undefined,
    metadata: metadata || {},
  };

  try {
    let entry;
    if (session) {
      const created = await MoneyLedgerEntry.create([payload], { session });
      entry = created[0];
    } else {
      entry = await MoneyLedgerEntry.create(payload);
    }
    return { ok: true, entry: entry.toObject ? entry.toObject() : entry, created: true };
  } catch (e) {
    if (e?.code === 11000) {
      const again = await MoneyLedgerEntry.findOne({ idempotencyKey }).lean();
      if (again) return { ok: true, entry: again, created: false };
    }
    return { ok: false, error: e?.message || "Failed to post ledger entry", status: 500 };
  }
}

/**
 * Signed balance for party.
 * AR: Σ(debit − credit) → + they owe
 * AP: Σ(credit − debit) → + we owe
 */
export async function getPartyBalance({ book, side, partyType, partyId }) {
  const match = {
    book,
    side,
    partyType,
    partyId: new mongoose.Types.ObjectId(String(partyId)),
  };
  const [row] = await MoneyLedgerEntry.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        debit: { $sum: "$debit" },
        credit: { $sum: "$credit" },
      },
    },
  ]);
  const debit = roundMoney(row?.debit);
  const credit = roundMoney(row?.credit);
  const balance = side === "AP" ? roundMoney(credit - debit) : roundMoney(debit - credit);
  return { debit, credit, balance };
}

export async function listPartyStatement({
  book,
  side,
  partyType,
  partyId,
  dateFrom,
  dateTo,
  limit = 500,
} = {}) {
  const filter = {
    book,
    side,
    partyType,
    partyId: new mongoose.Types.ObjectId(String(partyId)),
  };
  if (dateFrom || dateTo) {
    filter.entryDate = {};
    if (dateFrom) filter.entryDate.$gte = new Date(dateFrom);
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      filter.entryDate.$lte = to;
    }
  }

  const entries = await MoneyLedgerEntry.find(filter)
    .sort({ entryDate: 1, createdAt: 1 })
    .limit(Math.min(1000, Math.max(1, Number(limit) || 500)))
    .lean();

  let running = 0;
  const rows = entries.map((e) => {
    if (side === "AP") {
      running = roundMoney(running + (Number(e.credit) || 0) - (Number(e.debit) || 0));
    } else {
      running = roundMoney(running + (Number(e.debit) || 0) - (Number(e.credit) || 0));
    }
    return { ...e, runningBalance: running };
  });

  const totals = {
    debit: roundMoney(entries.reduce((s, e) => s + (Number(e.debit) || 0), 0)),
    credit: roundMoney(entries.reduce((s, e) => s + (Number(e.credit) || 0), 0)),
    closing: running,
  };

  return { entries: rows, totals };
}

/**
 * Distinct parties with balances for a book/side.
 */
export async function listPartiesWithBalances({ book, side, q = "", limit = 100 } = {}) {
  const match = { book, side };
  const term = String(q || "").trim();
  if (term) {
    match.$or = [
      { partyName: { $regex: term, $options: "i" } },
      ...(mongoose.isValidObjectId(term) ? [{ partyId: new mongoose.Types.ObjectId(term) }] : []),
    ];
  }

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: { partyType: "$partyType", partyId: "$partyId" },
        partyName: { $last: "$partyName" },
        partyType: { $first: "$partyType" },
        partyId: { $first: "$partyId" },
        debit: { $sum: "$debit" },
        credit: { $sum: "$credit" },
        lastEntryAt: { $max: "$entryDate" },
      },
    },
    {
      $addFields: {
        balance: {
          $cond: [
            { $eq: [side, "AP"] },
            { $subtract: ["$credit", "$debit"] },
            { $subtract: ["$debit", "$credit"] },
          ],
        },
      },
    },
    { $sort: { balance: -1, lastEntryAt: -1 } },
    { $limit: Math.min(200, Math.max(1, Number(limit) || 100)) },
  ];

  const rows = await MoneyLedgerEntry.aggregate(pipeline);
  return rows.map((r) => ({
    partyType: r.partyType,
    partyId: r.partyId,
    partyName: r.partyName || "",
    debit: roundMoney(r.debit),
    credit: roundMoney(r.credit),
    balance: roundMoney(r.balance),
    lastEntryAt: r.lastEntryAt,
  }));
}
