/**
 * Party-level payment / discount on Ram Agri unified ledger (no PO/order required).
 * Auto minus: reduces net balance (debit − credit).
 *   net > 0 (they owe) → Credit on AR
 *   net < 0 (we owe)  → Debit on AP
 */
import mongoose from "mongoose";
import Merchant from "../../models/merchant.model.js";
import Supplier from "../../models/supplier.model.js";
import MoneyLedgerEntry from "../../models/moneyLedgerEntry.model.js";
import { postEntry, roundMoney } from "./postEntry.js";
import { syncRamAgriMerchantAr } from "./agriSellPosts.js";
import { syncSupplierOutstanding } from "./purchasePosts.js";

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

/** Unified net = Σdebit − Σcredit (both AR+AP). >0 they owe; <0 we owe. */
export async function getRamAgriPartyNetBalance(partyType, partyId) {
  const [row] = await MoneyLedgerEntry.aggregate([
    {
      $match: {
        book: "RAM_AGRI",
        partyType: String(partyType).toUpperCase(),
        partyId: new mongoose.Types.ObjectId(String(partyId)),
      },
    },
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
  return { debit, credit, net: roundMoney(debit - credit) };
}

/**
 * @param {'PAYMENT'|'DISCOUNT'} kind
 * @param {'AUTO'|'COLLECT'|'PAY'} [direction] AUTO from net; COLLECT = AR credit; PAY = AP debit
 */
export async function postPartyAdjustment({
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
  idempotencyKey,
} = {}) {
  if (String(book).toUpperCase() !== "RAM_AGRI") {
    return { ok: false, error: "Party adjustments only supported on RAM_AGRI book", status: 400 };
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
  const { net } = await getRamAgriPartyNetBalance(pt, partyId);

  let dir = String(direction || "AUTO").toUpperCase();
  if (dir === "AUTO") {
    dir = net < 0 ? "PAY" : "COLLECT";
  }
  if (!["COLLECT", "PAY"].includes(dir)) {
    return { ok: false, error: "direction must be AUTO|COLLECT|PAY", status: 400 };
  }

  const side = dir === "PAY" ? "AP" : "AR";
  const debit = dir === "PAY" ? amt : 0;
  const credit = dir === "COLLECT" ? amt : 0;
  const partyName = await resolvePartyName(pt, partyId);

  const label = refType === "DISCOUNT" ? "Discount" : "Payment";
  const dirLabel =
    dir === "PAY"
      ? refType === "DISCOUNT"
        ? "purchase discount (we owe ↓)"
        : "paid to party"
      : refType === "DISCOUNT"
        ? "sale discount (they owe ↓)"
        : "collected from party";

  const key =
    idempotencyKey ||
    `ram_agri:party:${refType.toLowerCase()}:${pt}:${partyId}:${amt}:${Date.now()}`;

  const posted = await postEntry({
    book: "RAM_AGRI",
    side,
    partyType: pt,
    partyId,
    partyName,
    entryDate: entryDate || new Date(),
    refType,
    documentType: "Manual",
    documentNumber: "",
    debit,
    credit,
    description: `${label}: ${dirLabel}${remark ? ` · ${remark}` : ""}${
      modeOfPayment ? ` (${modeOfPayment})` : ""
    }`.trim(),
    reference: remark || modeOfPayment || label,
    idempotencyKey: key,
    createdBy: userId,
    metadata: {
      partyAdjustment: true,
      kind: refType,
      direction: dir,
      modeOfPayment: modeOfPayment || undefined,
      remark: remark || undefined,
      netBefore: net,
    },
  });

  if (!posted?.ok) return posted;

  if (pt === "MERCHANT") await syncRamAgriMerchantAr(partyId);
  await syncSupplierOutstanding(pt, partyId);

  const after = await getRamAgriPartyNetBalance(pt, partyId);
  return {
    ok: true,
    data: {
      entry: posted.entry,
      created: posted.created,
      direction: dir,
      side,
      netBefore: net,
      netAfter: after.net,
    },
  };
}
