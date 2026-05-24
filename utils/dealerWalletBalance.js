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
 * Cash wallet balance only (₹ the dealer can pay from wallet).
 * Uses embedded wallet transactions, then stored availableAmount.
 * Does NOT use DealerLedgerEntry — that tracks order receivable / outstanding, not cash.
 */
export async function resolveDealerCashBalance(dealerId, walletLean) {
  const embedded = balanceFromLastEmbeddedTransaction(walletLean);
  if (embedded !== null) return embedded;

  if (walletLean) {
    return Number(walletLean.availableAmount) || 0;
  }

  return 0;
}
