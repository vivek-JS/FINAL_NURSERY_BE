import crypto from "crypto";
import { iciciCorporateRequest } from "./iciciHttpClient.js";
import { getIciciCorporateConfig, assertCorporateConfig } from "../config/iciciCorporate.config.js";
import { normaliseStatementRow } from "../../../services/iciciStatement.service.js";
import { safeInsertBankTransactions } from "./duplicateDetection.service.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

function stubStatement(fromDate, toDate) {
  const from = new Date(fromDate);
  return [
    normaliseStatementRow(
      {
        txnDate: from,
        amount: 1500,
        referenceNumber: "STUBUTR4096",
        narration: "UPI/CR STUB CORPORATE",
        txnType: "CREDIT",
        balance: 250000,
      },
      0
    ),
  ];
}

function extractTransactions(response) {
  if (Array.isArray(response)) return response;
  const candidates = [
    response?.transactions,
    response?.statement,
    response?.entries,
    response?.data?.transactions,
    response?.AccountStatement?.transactions,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

/**
 * STEP 2 — Fetch Account Statement via Corporate HTTP API.
 */
export async function fetchCorporateStatement(fromDate, toDate, userId) {
  const cfg = getIciciCorporateConfig();

  if (cfg.useStub) {
    log().info("Corporate statement stub mode");
    return stubStatement(fromDate, toDate);
  }

  assertCorporateConfig();

  const from = new Date(fromDate);
  const to = new Date(toDate);
  const payload = {
    CORPID: cfg.corpId,
    USERID: cfg.userId,
    AGGRID: cfg.aggregatorId,
    ACCOUNTNO: cfg.accountNumber,
    FROMDATE: from.toISOString().slice(0, 10).replace(/-/g, ""),
    TODATE: to.toISOString().slice(0, 10).replace(/-/g, ""),
  };

  const idempotencyKey = crypto
    .createHash("sha256")
    .update(`${cfg.accountNumber}|${payload.FROMDATE}|${payload.TODATE}`)
    .digest("hex");

  const response = await iciciCorporateRequest({
    endpointPath: cfg.endpoints.statement,
    payload,
    idempotencyKey,
    userId,
  });

  const rows = extractTransactions(response);
  return rows.map((row, i) =>
    normaliseStatementRow(
      {
        ...row,
        accountNumber: cfg.accountNumber,
      },
      i
    )
  );
}

/**
 * Fetch + persist with duplicate-safe insert.
 */
export async function fetchAndStoreCorporateStatement(fromDate, toDate, userId) {
  const cfg = getIciciCorporateConfig();
  const rows = await fetchCorporateStatement(fromDate, toDate, userId);
  const enriched = rows.map((r) => ({
    ...r,
    accountNumber: cfg.accountNumber,
    source: "CORPORATE_HTTP",
  }));
  const persist = await safeInsertBankTransactions(enriched);
  return { ...persist, entries: enriched };
}
