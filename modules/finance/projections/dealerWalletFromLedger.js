import LedgerLine from "../ledger/models/ledgerLine.model.js";
import { ACCOUNT_CODES, PARTY_TYPES } from "../domain/constants.js";
import { roundMoney } from "../domain/roundMoney.js";
import DealerWallet from "../../../models/dealerWallet.js";

/**
 * Phase 3: derive dealer cash balance from DEALER_WALLET ledger lines (liability account).
 * Credit on liability = wallet balance increases.
 */
export async function getDealerWalletBalanceFromLedger(dealerId) {
  const lines = await LedgerLine.find({
    partyType: PARTY_TYPES.DEALER,
    partyId: String(dealerId),
    accountCode: ACCOUNT_CODES.DEALER_WALLET,
  }).lean();

  let balance = 0;
  for (const l of lines) {
    balance += (l.credit || 0) - (l.debit || 0);
  }
  return roundMoney(balance);
}

export async function syncDealerWalletCacheFromLedger(dealerId) {
  if (process.env.FINANCE_DERIVE_DEALER_WALLET !== "true") {
    return null;
  }
  const ledgerBal = await getDealerWalletBalanceFromLedger(dealerId);
  await DealerWallet.findOneAndUpdate(
    { dealer: dealerId },
    { $set: { availableAmount: ledgerBal } },
    { upsert: true }
  );
  return ledgerBal;
}
