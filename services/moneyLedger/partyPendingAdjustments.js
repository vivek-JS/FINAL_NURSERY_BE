/**
 * Party Money Ledger Payment/Discount: submit → PENDING → accept → postEntry.
 * Accept roles: Accountant, Super Admin, Ram Agri Input Master.
 */
import mongoose from "mongoose";
import Merchant from "../../models/merchant.model.js";
import Supplier from "../../models/supplier.model.js";
import MoneyLedgerPendingAdjustment from "../../models/moneyLedgerPendingAdjustment.model.js";
import { postPartyAdjustment } from "./partyAdjustments.js";
import { roundMoney } from "./postEntry.js";
import { resolvePartyAdjustEntryDate } from "../../utility/istLedgerDate.js";

const BOOKS = new Set(["RAM_AGRI", "BIOTECH"]);

export function canAcceptMoneyLedgerPartyAdjustment(user) {
  const jt = String(user?.jobTitle || "").toUpperCase().trim();
  const role = String(user?.role || "").toUpperCase().trim();
  return (
    jt === "RAM_AGRI_MASTER" ||
    role === "RAM_AGRI_MASTER" ||
    jt === "ACCOUNTANT" ||
    role === "ACCOUNTANT" ||
    jt === "SUPER_ADMIN" ||
    jt === "SUPERADMIN" ||
    role === "SUPER_ADMIN" ||
    role === "SUPERADMIN"
  );
}

async function resolvePartyName(partyType, partyId) {
  const pt = String(partyType || "").toUpperCase();
  if (pt === "MERCHANT") {
    const m = await Merchant.findById(partyId).select("name").lean();
    return m?.name || "";
  }
  if (pt === "SUPPLIER") {
    const s = await Supplier.findById(partyId).select("name").lean();
    return s?.name || "";
  }
  return "";
}

/**
 * Create PENDING party payment/discount (does not write MoneyLedgerEntry yet).
 */
export async function createPartyPendingAdjustment({
  book = "RAM_AGRI",
  partyType,
  partyId,
  amount,
  kind = "PAYMENT",
  direction = "AUTO",
  entryDate,
  modeOfPayment = "",
  remark = "",
  userId,
} = {}) {
  const b = String(book || "RAM_AGRI").toUpperCase();
  if (!BOOKS.has(b)) {
    return { ok: false, error: "book must be RAM_AGRI or BIOTECH", status: 400 };
  }
  const pt = String(partyType || "").toUpperCase();
  if (!["MERCHANT", "SUPPLIER"].includes(pt)) {
    return { ok: false, error: "partyType must be MERCHANT or SUPPLIER", status: 400 };
  }
  if (!mongoose.isValidObjectId(partyId)) {
    return { ok: false, error: "Valid partyId required", status: 400 };
  }
  const amt = roundMoney(amount);
  if (!(amt > 0)) return { ok: false, error: "amount must be > 0", status: 400 };

  const refType = String(kind || "PAYMENT").toUpperCase() === "DISCOUNT" ? "DISCOUNT" : "PAYMENT";
  let dir = String(direction || "AUTO").toUpperCase();
  if (!["AUTO", "COLLECT", "PAY"].includes(dir)) {
    return { ok: false, error: "direction must be AUTO|COLLECT|PAY", status: 400 };
  }

  const partyName = await resolvePartyName(pt, partyId);
  if (!partyName && pt === "MERCHANT") {
    const exists = await Merchant.exists({ _id: partyId });
    if (!exists) return { ok: false, error: "Merchant not found", status: 404 };
  }
  if (!partyName && pt === "SUPPLIER") {
    const exists = await Supplier.exists({ _id: partyId });
    if (!exists) return { ok: false, error: "Supplier not found", status: 404 };
  }

  const doc = await MoneyLedgerPendingAdjustment.create({
    book: b,
    partyType: pt,
    partyId,
    partyName: partyName || "",
    kind: refType,
    amount: amt,
    direction: dir,
    entryDate: resolvePartyAdjustEntryDate(entryDate),
    modeOfPayment: refType === "PAYMENT" ? String(modeOfPayment || "").trim() : "",
    remark: String(remark || "").trim(),
    status: "PENDING",
    createdBy: userId || undefined,
  });

  return {
    ok: true,
    data: {
      pending: doc.toObject(),
      requiresApproval: true,
      book: b,
    },
  };
}

export async function listPartyPendingAdjustments({
  book,
  status = "PENDING",
  q = "",
  page = 1,
  limit = 50,
} = {}) {
  const b = String(book || "").toUpperCase();
  const match = {};
  if (BOOKS.has(b)) match.book = b;
  const st = String(status || "").toUpperCase();
  if (["PENDING", "APPROVED", "REJECTED"].includes(st)) match.status = st;
  else if (st && st !== "ALL") match.status = "PENDING";

  const search = String(q || "").trim();
  if (search) {
    match.$or = [
      { partyName: { $regex: search, $options: "i" } },
      { remark: { $regex: search, $options: "i" } },
      { modeOfPayment: { $regex: search, $options: "i" } },
    ];
  }

  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const pg = Math.max(Number(page) || 1, 1);
  const skip = (pg - 1) * lim;

  const [rows, total, pendingCount] = await Promise.all([
    MoneyLedgerPendingAdjustment.find(match)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .populate("createdBy", "name phoneNumber jobTitle role")
      .populate("reviewedBy", "name phoneNumber jobTitle role")
      .lean(),
    MoneyLedgerPendingAdjustment.countDocuments(match),
    MoneyLedgerPendingAdjustment.countDocuments({
      ...(BOOKS.has(b) ? { book: b } : {}),
      status: "PENDING",
    }),
  ]);

  return {
    ok: true,
    data: {
      data: rows,
      total,
      page: pg,
      limit: lim,
      totalPages: Math.max(1, Math.ceil(total / lim)),
      pendingCount,
    },
  };
}

export async function acceptPartyPendingAdjustment({ id, userId, user } = {}) {
  if (!canAcceptMoneyLedgerPartyAdjustment(user)) {
    return {
      ok: false,
      error: "Only Accountant, Super Admin, or Ram Agri Input Master can accept",
      status: 403,
    };
  }
  if (!mongoose.isValidObjectId(id)) {
    return { ok: false, error: "Invalid id", status: 400 };
  }

  const pending = await MoneyLedgerPendingAdjustment.findById(id);
  if (!pending) return { ok: false, error: "Pending adjustment not found", status: 404 };
  if (pending.status !== "PENDING") {
    return {
      ok: false,
      error: `Already ${pending.status}`,
      status: 409,
    };
  }

  const posted = await postPartyAdjustment({
    book: pending.book,
    partyType: pending.partyType,
    partyId: pending.partyId,
    amount: pending.amount,
    kind: pending.kind,
    direction: pending.direction,
    entryDate: pending.entryDate,
    modeOfPayment: pending.modeOfPayment,
    remark: pending.remark,
    userId: userId || user?._id || user?.id,
    idempotencyKey: `pending_adj:${pending._id}`,
  });

  if (!posted?.ok) {
    return {
      ok: false,
      error: posted?.error || "Failed to post ledger entry",
      status: posted?.status || 400,
    };
  }

  pending.status = "APPROVED";
  pending.reviewedBy = userId || user?._id || user?.id;
  pending.reviewedAt = new Date();
  pending.ledgerEntryId = posted.data?.entry?._id || posted.data?.entry?.id || undefined;
  await pending.save();

  return {
    ok: true,
    data: {
      pending: pending.toObject(),
      ledger: posted.data,
    },
  };
}

export async function rejectPartyPendingAdjustment({
  id,
  userId,
  user,
  reason = "",
} = {}) {
  if (!canAcceptMoneyLedgerPartyAdjustment(user)) {
    return {
      ok: false,
      error: "Only Accountant, Super Admin, or Ram Agri Input Master can reject",
      status: 403,
    };
  }
  if (!mongoose.isValidObjectId(id)) {
    return { ok: false, error: "Invalid id", status: 400 };
  }

  const pending = await MoneyLedgerPendingAdjustment.findById(id);
  if (!pending) return { ok: false, error: "Pending adjustment not found", status: 404 };
  if (pending.status !== "PENDING") {
    return { ok: false, error: `Already ${pending.status}`, status: 409 };
  }

  pending.status = "REJECTED";
  pending.reviewedBy = userId || user?._id || user?.id;
  pending.reviewedAt = new Date();
  pending.rejectReason = String(reason || "").trim();
  await pending.save();

  return { ok: true, data: { pending: pending.toObject() } };
}
