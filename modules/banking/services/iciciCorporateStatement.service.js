import crypto from "crypto";
import { iciciCorporateRequest } from "./iciciHttpClient.js";
import { getIciciCorporateConfig, assertCorporateConfig } from "../config/iciciCorporate.config.js";
import { normaliseStatementRow } from "../../../services/iciciStatement.service.js";
import { safeInsertBankTransactions } from "./duplicateDetection.service.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

/**
 * The CIB_SV sandbox only has canned statement data in this window
 * (ICICI UAT mail). Dates must be sent as dd-mm-yyyy, not YYYYMMDD.
 */
export const SANDBOX_STATEMENT_FROM = "2024-01-01";
export const SANDBOX_STATEMENT_TO = "2024-02-10";

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** CIB_SV AccountStatement sample: "01-01-2024". */
export function formatCibSvStatementDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

/**
 * If this is the sandbox and the requested range is outside the canned
 * window, use the window ICICI actually answers. Otherwise a Sync on
 * today's dates comes back empty and looks like the bank is down.
 */
export function resolveStatementWindow(fromDate, toDate, cfg) {
  const requestedFrom = new Date(fromDate);
  const requestedTo = new Date(toDate);
  const sandbox = !cfg.isProd && !cfg.useStub;

  if (!sandbox) {
    return {
      from: requestedFrom,
      to: requestedTo,
      clamped: false,
      fromDate: requestedFrom.toISOString().slice(0, 10),
      toDate: requestedTo.toISOString().slice(0, 10),
    };
  }

  const winFrom = new Date(`${SANDBOX_STATEMENT_FROM}T00:00:00.000Z`);
  const winTo = new Date(`${SANDBOX_STATEMENT_TO}T23:59:59.999Z`);
  const overlaps = requestedFrom <= winTo && requestedTo >= winFrom;
  if (overlaps) {
    const from = requestedFrom < winFrom ? winFrom : requestedFrom;
    const to = requestedTo > winTo ? winTo : requestedTo;
    const clamped = from.getTime() !== requestedFrom.getTime() || to.getTime() !== requestedTo.getTime();
    return {
      from,
      to,
      clamped,
      fromDate: from.toISOString().slice(0, 10),
      toDate: to.toISOString().slice(0, 10),
    };
  }

  return {
    from: winFrom,
    to: winTo,
    clamped: true,
    fromDate: SANDBOX_STATEMENT_FROM,
    toDate: SANDBOX_STATEMENT_TO,
  };
}

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
    response?.Transactions,
    response?.STATEMENT,
    response?.statement,
    response?.Record,
    response?.RECORD,
    response?.entries,
    response?.data?.transactions,
    response?.AccountStatement?.transactions,
    response?.ACCOUNTSTATEMENT?.TRANSACTION,
    response?.ACCOUNTSTATEMENT?.transactions,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
    if (c && typeof c === "object" && !Array.isArray(c)) {
      // Some packets wrap a single row as an object.
      if (c.AMOUNT != null || c.amount != null || c.TXNDATE || c.txnDate) return [c];
    }
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

  const window = resolveStatementWindow(fromDate, toDate, cfg);
  const payload = {
    CORPID: cfg.corpId,
    USERID: cfg.userId,
    AGGRID: cfg.aggregatorId,
    ACCOUNTNO: cfg.accountNumber,
    FROMDATE: formatCibSvStatementDate(window.from),
    TODATE: formatCibSvStatementDate(window.to),
    URN: cfg.urn,
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
  const window = resolveStatementWindow(fromDate, toDate, cfg);
  const rows = await fetchCorporateStatement(window.fromDate, window.toDate, userId);
  const enriched = rows.map((r) => ({
    ...r,
    accountNumber: cfg.accountNumber,
    source: "CORPORATE_HTTP",
  }));
  const persist = await safeInsertBankTransactions(enriched);
  return {
    ...persist,
    entries: enriched,
    window: { fromDate: window.fromDate, toDate: window.toDate, clamped: window.clamped },
    message: window.clamped
      ? `Sandbox statement window is ${window.fromDate} to ${window.toDate} — fetched that range`
      : undefined,
  };
}
