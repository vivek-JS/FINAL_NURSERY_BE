/**
 * Append-only money ledger reversal / correction.
 * Never updates or deletes existing lines — posts an opposite entry.
 */
import MoneyLedgerEntry from "../../models/moneyLedgerEntry.model.js";
import { postEntry, roundMoney } from "./postEntry.js";
import { syncSupplierOutstanding } from "./purchasePosts.js";

/**
 * Reverse an existing ledger entry by posting the opposite debit/credit.
 * @param {object} opts
 * @param {string|object} opts.entryId - MoneyLedgerEntry id to reverse
 * @param {string} [opts.reason]
 * @param {object} [opts.userId]
 * @param {string} [opts.idempotencySuffix] - unique correction token
 */
export async function postLedgerReversal({
  entryId,
  reason = "",
  userId,
  idempotencySuffix = "",
} = {}) {
  if (!entryId) return { ok: false, error: "entryId required", status: 400 };

  const original = await MoneyLedgerEntry.findById(entryId).lean();
  if (!original) return { ok: false, error: "Ledger entry not found", status: 404 };

  const already = await MoneyLedgerEntry.exists({
    "metadata.reversesEntryId": original._id,
    refType: "REVERSAL",
  });
  if (already) {
    return { ok: true, skipped: true, reason: "already_reversed" };
  }

  const debit = roundMoney(original.credit); // flip
  const credit = roundMoney(original.debit);
  if (debit <= 0 && credit <= 0) {
    return { ok: false, error: "Original entry has no amount", status: 400 };
  }

  const suffix = idempotencySuffix || Date.now().toString(36);
  const r = await postEntry({
    book: original.book,
    side: original.side,
    partyType: original.partyType,
    partyId: original.partyId,
    partyName: original.partyName || "",
    entryDate: new Date(),
    refType: "REVERSAL",
    documentType: original.documentType || "Other",
    documentId: original.documentId,
    documentNumber: original.documentNumber || "",
    debit,
    credit,
    description: `Reversal of ${original.refType} ${original.documentNumber || ""} ${
      reason ? `· ${reason}` : ""
    }`.trim(),
    reference: original.reference || original.documentNumber || "",
    idempotencyKey: `reversal:${original.idempotencyKey}:${suffix}`,
    createdBy: userId,
    metadata: {
      reversesEntryId: original._id,
      reversesIdempotencyKey: original.idempotencyKey,
      correctionReason: reason || "",
    },
  });

  if (r?.ok && original.side === "AP") {
    await syncSupplierOutstanding(original.partyType, original.partyId);
  }

  return r;
}

/**
 * Reverse all PURCHASE_RETURN ledger lines for a purchase return document.
 */
export async function reversePurchaseReturnAp(purchaseReturnDoc, userId, reason = "") {
  if (!purchaseReturnDoc?._id) {
    return { ok: false, error: "Missing purchase return", status: 400 };
  }
  const entries = await MoneyLedgerEntry.find({
    documentType: "PurchaseReturn",
    documentId: purchaseReturnDoc._id,
    refType: "PURCHASE_RETURN",
  }).lean();

  const results = [];
  for (const e of entries) {
    results.push(
      await postLedgerReversal({
        entryId: e._id,
        reason: reason || `Correct purchase return ${purchaseReturnDoc.returnNumber || ""}`,
        userId,
        idempotencySuffix: "pr",
      })
    );
  }
  return { ok: true, results, reversed: results.filter((x) => x?.created).length };
}
