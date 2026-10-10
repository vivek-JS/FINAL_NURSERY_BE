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

export const STATEMENT_MAX_PAGES = 100;
const PAGE_GAP_MS = 600;

/**
 * ICICI sends LASTTRID (its sample spells it LISTTRID) when more than 200
 * records match; the next page is asked for with CONFLG=Y and that value,
 * sent exactly as received.
 */
export function lastTransactionIdOf(response) {
  if (!response || typeof response !== "object") return "";
  for (const [key, value] of Object.entries(response)) {
    if (/^(LASTTRID|LISTTRID)$/i.test(key) && value != null && String(value).trim()) return String(value);
  }
  return "";
}

function failureMessageOf(response) {
  const flag = response?.RESPONSE ?? response?.response ?? response?.Response;
  if (!/fail/i.test(String(flag || ""))) return "";
  return String(response?.MESSAGE ?? response?.message ?? response?.Message ?? "ICICI returned FAILURE");
}

/**
 * Walk every page of a statement. `fetchPage({ conflg, lastTrId, page })`
 * returns the raw ICICI response. Stops when ICICI sends no LASTTRID, repeats
 * it, sends no rows, or after STATEMENT_MAX_PAGES. A failure after the first
 * page keeps what was fetched and says the statement is incomplete.
 */
export async function collectStatementPages(fetchPage, { maxPages = STATEMENT_MAX_PAGES, gapMs = 0 } = {}) {
  const rows = [];
  let lastTrId = "";
  let pages = 0;
  let complete = true;
  let warning;

  for (;;) {
    if (pages > 0 && gapMs) await new Promise((r) => setTimeout(r, gapMs));
    let response;
    try {
      response = await fetchPage({ conflg: pages === 0 ? "N" : "Y", lastTrId, page: pages + 1 });
    } catch (err) {
      if (pages === 0) throw err;
      complete = false;
      warning = `ICICI stopped answering after page ${pages} (${err.message}); sync again to load the rest`;
      break;
    }
    pages += 1;

    const failure = failureMessageOf(response);
    const pageRows = extractTransactions(response);
    if (failure && !pageRows.length) {
      if (pages > 1) {
        complete = false;
        warning = `ICICI failed on page ${pages}: ${failure}; sync again to load the rest`;
      } else {
        warning = failure;
      }
      break;
    }
    rows.push(...pageRows);

    const next = lastTransactionIdOf(response);
    if (!next || !pageRows.length) break;
    if (next === lastTrId) {
      complete = false;
      warning = "ICICI repeated the same page marker; stopped to avoid a loop";
      break;
    }
    if (pages >= maxPages) {
      complete = false;
      warning = `Stopped after ${maxPages} pages — use a shorter date range`;
      break;
    }
    lastTrId = next;
  }

  return { rows, pages, complete, warning };
}

/**
 * STEP 2 — Fetch Account Statement via Corporate HTTP API (all pages).
 * Returns { rows, pages, complete, warning }.
 */
export async function fetchCorporateStatementPages(fromDate, toDate, userId) {
  const cfg = getIciciCorporateConfig();

  if (cfg.useStub) {
    log().info("Corporate statement stub mode");
    return { rows: stubStatement(fromDate, toDate), pages: 1, complete: true };
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

  // No idempotency key: syncing the same range later must return the lines
  // that arrived since, not a replay of the earlier answer.
  const result = await collectStatementPages(
    ({ conflg, lastTrId }) =>
      iciciCorporateRequest({
        endpointPath: conflg === "N" ? cfg.endpoints.statement : cfg.endpoints.statementNextPage,
        payload: conflg === "N" ? payload : { ...payload, CONFLG: "Y", LASTTRID: lastTrId },
        userId,
      }),
    { gapMs: PAGE_GAP_MS }
  );

  return {
    ...result,
    rows: result.rows.map((row, i) => normaliseStatementRow({ ...row, accountNumber: cfg.accountNumber }, i)),
  };
}

export async function fetchCorporateStatement(fromDate, toDate, userId) {
  return (await fetchCorporateStatementPages(fromDate, toDate, userId)).rows;
}

/**
 * Fetch every page and save only the lines not already in the system.
 */
export async function fetchAndStoreCorporateStatement(fromDate, toDate, userId) {
  const cfg = getIciciCorporateConfig();
  const window = resolveStatementWindow(fromDate, toDate, cfg);
  const fetched = await fetchCorporateStatementPages(window.fromDate, window.toDate, userId);
  const enriched = fetched.rows.map((r) => ({
    ...r,
    accountNumber: cfg.accountNumber,
    source: "CORPORATE_HTTP",
  }));
  const persist = await safeInsertBankTransactions(enriched);

  const parts = [
    `Fetched ${enriched.length} line${enriched.length === 1 ? "" : "s"} from ICICI` +
      (fetched.pages > 1 ? ` (${fetched.pages} pages)` : ""),
    `${persist.inserted} new saved`,
    `${persist.alreadySaved} already in the system`,
  ];
  if (persist.repeatedInBatch) parts.push(`${persist.repeatedInBatch} repeated by the bank, ignored`);
  const notes = [
    window.clamped ? `Sandbox statement window is ${window.fromDate} to ${window.toDate} — fetched that range` : "",
    fetched.warning || "",
  ].filter(Boolean);

  return {
    ...persist,
    entries: enriched,
    pages: fetched.pages,
    complete: fetched.complete,
    warning: fetched.warning,
    window: { fromDate: window.fromDate, toDate: window.toDate, clamped: window.clamped },
    message: [parts.join(", ") + ".", ...notes].join(" "),
  };
}
