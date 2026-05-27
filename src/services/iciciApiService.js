/**
 * ICICI Corporate API service — registration, statement, health.
 * Uses modular iciciCrypto wrapper; swap encryption without changing this file's logic.
 */

import axios from "axios";
import winston from "winston";
import {
  encryptPayload,
  decryptPayload,
  getCertificateHealth,
  readPublicCertPem,
  usePassthroughEncryption,
  useHybridEncryption,
  getEncryptionWrapperName,
} from "../utils/iciciCrypto.js";
import { maskObject } from "../utils/iciciLogMask.js";

const log = winston.createLogger({
  level: process.env.ICICI_LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      const safe = maskObject(meta);
      const rest = Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : "";
      return `${timestamp} [${level}] [ICICI] ${message}${rest}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

function isStubMode() {
  return String(process.env.ICICI_USE_STUB || "false").toLowerCase() === "true";
}

function getConfig() {
  const baseUrl =
    process.env.ICICI_BASE_URL || "https://apibankingonesandbox.icicibank.com";
  return {
    baseUrl,
    apiPrefix: process.env.ICICI_API_PREFIX || "/api/Corporate/CIB/v1",
    aggrId: process.env.ICICI_AGGRID || "",
    aggrName: process.env.ICICI_AGGRNAME || "",
    corpId: process.env.ICICI_CORPID || "",
    userId: process.env.ICICI_USERID || "",
    urn: process.env.ICICI_URN || "",
    accountNo: process.env.ICICI_ACCOUNT_NO || "",
    apiKey: process.env.ICICI_API_KEY || "",
    timeoutMs: Number(process.env.ICICI_TIMEOUT_MS || 60000),
    retryAttempts: Number(process.env.ICICI_RETRY_ATTEMPTS || 3),
  };
}

function assertConfig(fields = []) {
  const cfg = getConfig();
  const missing = fields.filter((f) => !cfg[f] && !process.env[`ICICI_${f.toUpperCase()}`]);
  const map = {
    corpId: cfg.corpId,
    userId: cfg.userId,
    aggrId: cfg.aggrId,
    accountNo: cfg.accountNo,
  };
  const absent = fields.filter((f) => !map[f]);
  if (absent.length) {
    const err = new Error(`Missing ICICI config: ${absent.join(", ")}`);
    err.code = "ICICI_CONFIG";
    throw err;
  }
  return cfg;
}

function buildUrl(pathSuffix) {
  const cfg = getConfig();
  return `${cfg.baseUrl}${cfg.apiPrefix}${pathSuffix}`;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function iciciPost(pathSuffix, plainPayload, options = {}) {
  if (isStubMode()) {
    usePassthroughEncryption();
  } else {
    useHybridEncryption();
  }

  const cfg = getConfig();
  const url = buildUrl(pathSuffix);
  const body = isStubMode() ? plainPayload : encryptPayload(plainPayload);

  log.info("ICICI request", {
    path: pathSuffix,
    encryption: getEncryptionWrapperName(),
    payload: maskObject(plainPayload),
  });

  let lastErr;
  for (let attempt = 1; attempt <= cfg.retryAttempts; attempt += 1) {
    try {
      const res = await axios.post(url, body, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(cfg.apiKey ? { apikey: cfg.apiKey } : {}),
          ...(options.idempotencyKey
            ? { "X-Idempotency-Key": options.idempotencyKey }
            : {}),
        },
        timeout: cfg.timeoutMs,
        validateStatus: () => true,
      });

      if (res.status >= 400) {
        const err = new Error(
          res.data?.message || res.data?.error || `ICICI HTTP ${res.status}`
        );
        err.code = res.data?.code || `ICICI_HTTP_${res.status}`;
        err.response = res;
        throw err;
      }

      let data = res.data;
      if (data?.encryptedKey && data?.encryptedData) {
        data = decryptPayload(data);
      }

      log.info("ICICI response OK", { path: pathSuffix, status: res.status });
      return data;
    } catch (err) {
      lastErr = err;
      const retryable =
        [408, 429, 500, 502, 503, 504].includes(err.response?.status) ||
        ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED"].includes(err.code);

      if (!retryable || attempt === cfg.retryAttempts) break;
      const wait = 1500 * attempt;
      log.warn(`ICICI retry ${attempt}/${cfg.retryAttempts}`, { error: err.message, wait });
      await sleep(wait);
    }
  }

  log.error("ICICI request failed", { path: pathSuffix, error: lastErr.message });
  throw lastErr;
}

/** GET /api/icici/health */
export function getHealth() {
  const cert = getCertificateHealth();
  const cfg = getConfig();
  return {
    status: cert.ready || isStubMode() ? "ok" : "degraded",
    stubMode: isStubMode(),
    encryption: getEncryptionWrapperName(),
    certificates: cert,
    config: {
      baseUrl: cfg.baseUrl,
      corpId: cfg.corpId ? `${cfg.corpId.slice(0, 2)}****` : null,
      accountNo: cfg.accountNo ? `****${String(cfg.accountNo).slice(-4)}` : null,
    },
  };
}

/** POST /api/icici/register */
export async function registerWithIcici() {
  if (isStubMode()) {
    return {
      status: "SUCCESS",
      registrationId: `STUB-REG-${Date.now()}`,
      message: "Stub mode — set ICICI_USE_STUB=false for live registration",
    };
  }

  assertConfig(["corpId", "userId", "aggrId"]);

  const publicCertPem = readPublicCertPem();
  if (!publicCertPem) {
    const err = new Error("public.crt not found — run scripts/generate-icici-cert.sh");
    err.code = "ICICI_PUBLIC_CERT_MISSING";
    throw err;
  }

  const cfg = getConfig();
  const payload = {
    AGGR_ID: cfg.aggrId,
    AGGR_NAME: cfg.aggrName,
    CORPID: cfg.corpId,
    USERID: cfg.userId,
    URN: cfg.urn,
    PUBLIC_KEY: publicCertPem.replace(/\r\n/g, "\n").trim(),
    ALIAS: process.env.ICICI_CERT_ALIAS || "ERP_PRIMARY",
  };

  const response = await iciciPost(
    process.env.ICICI_REGISTRATION_PATH || "/Registration",
    payload,
    { idempotencyKey: `reg-${cfg.corpId}-${cfg.userId}` }
  );

  return {
    status: response?.status || response?.STATUS || "SUCCESS",
    registrationId: response?.registrationId || response?.REG_ID || response?.requestId,
    response: maskObject(response),
  };
}

function normaliseStatementRow(raw, index = 0) {
  const r = raw || {};
  const txnDate = r.txnDate || r.transactionDate || r.valueDate || r.date || new Date();
  const amount = Number(r.amount ?? r.creditAmount ?? r.txnAmount ?? 0);
  return {
    txnDate: txnDate instanceof Date ? txnDate : new Date(txnDate),
    amount: Math.round(amount * 100) / 100,
    referenceNumber: String(r.referenceNumber ?? r.utr ?? r.UTR ?? "").trim(),
    narration: String(r.narration ?? r.description ?? ""),
    txnType: String(r.txnType ?? r.type ?? ""),
    balance: r.balance != null ? Number(r.balance) : undefined,
    transactionId: String(r.transactionId ?? r.txnId ?? "").trim(),
    raw: r,
    index,
  };
}

function extractTransactions(response) {
  if (Array.isArray(response)) return response;
  for (const key of ["transactions", "statement", "entries", "data"]) {
    const v = response?.[key];
    if (Array.isArray(v)) return v;
    if (v?.transactions && Array.isArray(v.transactions)) return v.transactions;
  }
  return [];
}

/** POST /api/icici/statement */
export async function fetchAccountStatement(fromDate, toDate) {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    const err = new Error("Invalid fromDate or toDate");
    err.code = "VALIDATION";
    throw err;
  }
  if (from > to) {
    const err = new Error("fromDate must be before toDate");
    err.code = "VALIDATION";
    throw err;
  }

  if (isStubMode()) {
    return {
      stub: true,
      fromDate: from.toISOString().slice(0, 10),
      toDate: to.toISOString().slice(0, 10),
      transactions: [
        normaliseStatementRow(
          {
            txnDate: from,
            amount: 1500,
            referenceNumber: "STUBUTR001",
            narration: "UPI/CR STUB",
            txnType: "CREDIT",
          },
          0
        ),
      ],
    };
  }

  assertConfig(["corpId", "userId", "aggrId", "accountNo"]);

  const cfg = getConfig();
  const payload = {
    AGGR_ID: cfg.aggrId,
    AGGR_NAME: cfg.aggrName,
    CORPID: cfg.corpId,
    USERID: cfg.userId,
    URN: cfg.urn,
    ACCOUNTNO: cfg.accountNo,
    FROMDATE: from.toISOString().slice(0, 10).replace(/-/g, ""),
    TODATE: to.toISOString().slice(0, 10).replace(/-/g, ""),
  };

  const response = await iciciPost(
    process.env.ICICI_STATEMENT_PATH || "/AccountStatement",
    payload,
    {
      idempotencyKey: `stmt-${cfg.accountNo}-${payload.FROMDATE}-${payload.TODATE}`,
    }
  );

  const rows = extractTransactions(response).map(normaliseStatementRow);
  return {
    fromDate: from.toISOString().slice(0, 10),
    toDate: to.toISOString().slice(0, 10),
    count: rows.length,
    transactions: rows,
  };
}

export { getConfig, isStubMode };
