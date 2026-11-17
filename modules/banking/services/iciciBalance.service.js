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

  return { ...mapBalanceReply(response, cfg.accountNumber), raw: response };
}

/** CIB_SV answers with EFFECTIVEBAL (string); RESPONSE "Failure" carries MESSAGE instead. */
export function mapBalanceReply(response, accountNumber) {
  const ok = String(response?.RESPONSE || response?.response || "SUCCESS").toUpperCase() === "SUCCESS";
  if (!ok) {
    const err = new Error(response?.MESSAGE || response?.message || "ICICI balance enquiry failed");
    err.code = "ICICI_BALANCE_FAILED";
    throw err;
  }
  const effective =
    response?.EFFECTIVEBAL ?? response?.availableBalance ?? response?.AVAILABLE_BALANCE ?? response?.balance ?? 0;
  const amount = Number(String(effective).replace(/,/g, ""));
  return {
    accountNumber: response?.ACCOUNTNO || accountNumber,
    availableBalance: amount,
    ledgerBalance: Number(response?.ledgerBalance ?? response?.LEDGER_BALANCE ?? amount),
    currency: response?.CURRENCY || response?.currency || "INR",
    bankDate: response?.DATE || null,
    asOf: new Date().toISOString(),
    source: "BALANCE_API",
  };
}
