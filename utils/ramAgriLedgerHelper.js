import RamAgriCustomerLedgerEntry from "../models/ramAgriCustomerLedger.model.js";
import { roundMoney } from "./farmerPlantOrderLedgerHelper.js";

/** Last 10 digits for consistent matching when possible */
export function normalizeAgriCustomerMobile(m) {
  const d = String(m || "").replace(/\D/g, "");
  if (d.length >= 10) return d.slice(-10);
  return d || "";
}

/**
 * Running receivable after all lines (+ = customer owes, − = advance).
 * Uses exact customerMobile match as stored in DB.
 */
export async function getRamAgriRunningBalanceAfterMobile(customerMobile, session) {
  const m = String(customerMobile || "").trim();
  if (!m) return 0;
  const q = RamAgriCustomerLedgerEntry.find({ customerMobile: m })
    .sort({ entryDate: 1, createdAt: 1 })
    .lean();
  if (session) q.session(session);
  const rows = await q;
  let running = 0;
  for (const e of rows) {
    running = roundMoney(
      running + (Number(e.debit) || 0) - (Number(e.credit) || 0)
    );
  }
  return running;
}

export const createCustomerLedgerEntry = async ({
  customerMobile,
  customerName,
  refType,
  refId,
  orderId,
  paymentId,
  debit = 0,
  credit = 0,
  reference,
  category,
  description,
  entryDate,
  createdBy,
  metadata = {},
  session,
  idempotencyKey,
}) => {
  if (!customerMobile) {
    return null;
  }

  const mobile =
    normalizeAgriCustomerMobile(customerMobile) || String(customerMobile).trim();
  if (!mobile) return null;

  const key = idempotencyKey || metadata?.idempotencyKey || null;
  if (key) {
    const existing = await RamAgriCustomerLedgerEntry.findOne({
      "metadata.idempotencyKey": key,
    })
      .session(session || null)
      .lean();
    if (existing) return existing;
  }

  const normalizedDebit = Math.abs(Number(debit || 0));
  const normalizedCredit = Math.abs(Number(credit || 0));

  if (normalizedDebit === 0 && normalizedCredit === 0) {
    return null;
  }

  const entryPayload = {
    customerMobile: mobile,
    customerName: customerName?.trim() || "",
    entryDate: entryDate ? new Date(entryDate) : new Date(),
    refType,
    refId,
    orderId,
    paymentId,
    debit: normalizedDebit,
    credit: normalizedCredit,
    reference,
    category,
    description,
    createdBy,
    metadata: key ? { ...metadata, idempotencyKey: key } : metadata,
  };

  let entry;
  if (session) {
    const created = await RamAgriCustomerLedgerEntry.create([entryPayload], { session });
    entry = created[0];
  } else {
    entry = await RamAgriCustomerLedgerEntry.create(entryPayload);
  }

  if (entry) {
    try {
      const fs = await import("../modules/finance/integration/financeShadow.js");
      await fs.shadowAgriFromLedgerRow({
        entry,
        createdBy,
        previousStatus: metadata?.previousPaymentStatus,
        newStatus: metadata?.newPaymentStatus,
        payment: metadata?.paymentSnapshot,
      });
    } catch (shadowErr) {
      console.error("[Finance] shadow agri ledger:", shadowErr?.message || shadowErr);
    }
  }

  return entry;
};
