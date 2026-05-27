import { iciciCorporateRequest } from "./iciciHttpClient.js";
import { getIciciCorporateConfig, assertCorporateConfig } from "../config/iciciCorporate.config.js";

/**
 * Balance Fetch API.
 */
export async function fetchAccountBalance(userId) {
  const cfg = getIciciCorporateConfig();

  if (cfg.useStub) {
    return {
      accountNumber: cfg.accountNumber || "STUB-ACCOUNT",
      availableBalance: 250000.5,
      ledgerBalance: 250000.5,
      currency: "INR",
      asOf: new Date().toISOString(),
      source: "STUB",
    };
  }

  assertCorporateConfig();

  const payload = {
    CORPID: cfg.corpId,
    USERID: cfg.userId,
    AGGRID: cfg.aggregatorId,
    ACCOUNTNO: cfg.accountNumber,
  };

  const response = await iciciCorporateRequest({
    endpointPath: cfg.endpoints.balance,
    payload,
    idempotencyKey: `balance-${cfg.accountNumber}-${new Date().toISOString().slice(0, 10)}`,
    userId,
  });

  return {
    accountNumber: cfg.accountNumber,
    availableBalance: Number(
      response?.availableBalance ?? response?.AVAILABLE_BALANCE ?? response?.balance ?? 0
    ),
    ledgerBalance: Number(
      response?.ledgerBalance ?? response?.LEDGER_BALANCE ?? response?.balance ?? 0
    ),
    currency: response?.currency || "INR",
    asOf: new Date().toISOString(),
    raw: response,
    source: "BALANCE_API",
  };
}
