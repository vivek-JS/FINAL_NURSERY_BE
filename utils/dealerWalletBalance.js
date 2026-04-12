import mongoose from "mongoose";
import DealerLedgerEntry from "../models/dealerLedgerEntry.model.js";

/**
 * Running balance from the newest embedded wallet transaction (audit chain).
 * addPayment() always appends a tx with balanceAfter; if availableAmount was
 * edited directly in DB, this still reflects the true sequence of movements.
 */
export function balanceFromLastEmbeddedTransaction(wallet) {
  const txs = wallet?.transactions;
  if (!Array.isArray(txs) || txs.length === 0) return null;
  const sorted = [...txs].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (tb !== ta) return tb - ta;
    const ida = a._id != null ? String(a._id) : "";
    const idb = b._id != null ? String(b._id) : "";
    return idb.localeCompare(ida);
  });
  const v = Number(sorted[0]?.balanceAfter);
  return Number.isFinite(v) ? v : null;
}

/**
 * Best-effort cash balance for API/UI: embedded tx chain → immutable ledger → stored field.
 */
export async function resolveDealerCashBalance(dealerId, walletLean) {
  const embedded = balanceFromLastEmbeddedTransaction(walletLean);
  if (embedded !== null) return embedded;

  if (dealerId && mongoose.Types.ObjectId.isValid(String(dealerId))) {
    const latest = await DealerLedgerEntry.findOne({
      dealer: new mongoose.Types.ObjectId(dealerId),
    })
      .sort({ entryDate: -1, createdAt: -1 })
      .select("balanceAfter")
      .lean();
    const lv = Number(latest?.balanceAfter);
    if (Number.isFinite(lv)) return lv;
  }

  return walletLean ? Number(walletLean.availableAmount) || 0 : 0;
}
