/**
 * Phase 3: when FINANCE_USE_PROJECTION=true, sub-ledger writes route through projections
 * instead of direct helper calls. Shadow mode keeps both paths until reconciliation passes.
 */
export { syncDealerWalletCacheFromLedger } from "./dealerWalletFromLedger.js";

export const FINANCE_USE_PROJECTION =
  process.env.FINANCE_USE_PROJECTION === "true";
