import { iciciCorporateRequest } from "./iciciHttpClient.js";
import { getIciciCorporateConfig, assertCorporateConfig } from "../config/iciciCorporate.config.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

/**
 * Transaction Status API — verify individual payment by UTR / merchant ref.
 */
export async function fetchTransactionStatus({ utr, merchantTranId, amount, userId }) {
  const cfg = getIciciCorporateConfig();

  if (cfg.useStub) {
    return {
      status: "SUCCESS",
      utr: utr || "STUBUTR4096",
      merchantTranId: merchantTranId || "STUB-MTX",
      amount: amount || 0,
      verifiedAt: new Date().toISOString(),
      source: "STUB",
    };
  }

  assertCorporateConfig();

  const payload = {
    CORPID: cfg.corpId,
    USERID: cfg.userId,
    AGGRID: cfg.aggregatorId,
    ACCOUNTNO: cfg.accountNumber,
    UTR: utr || "",
    MERCHANTTRANID: merchantTranId || "",
    AMOUNT: amount != null ? Number(amount).toFixed(2) : "",
  };

  const response = await iciciCorporateRequest({
    endpointPath: cfg.endpoints.transactionStatus,
    payload,
    idempotencyKey: `status-${utr || merchantTranId}`,
    userId,
  });

  const status = String(
    response?.status || response?.STATUS || response?.txnStatus || "UNKNOWN"
  ).toUpperCase();

  log().info("Transaction status fetched", { utr, merchantTranId, status });
  return {
    status,
    utr: response?.utr || response?.UTR || utr,
    merchantTranId: response?.merchantTranId || merchantTranId,
    amount: response?.amount || amount,
    raw: response,
    verifiedAt: new Date().toISOString(),
    source: "TXN_STATUS_API",
  };
}
