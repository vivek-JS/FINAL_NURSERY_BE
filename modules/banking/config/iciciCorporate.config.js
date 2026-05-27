import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "../../..");

export function resolveBankingPath(p) {
  if (!p || typeof p !== "string") return null;
  if (path.isAbsolute(p)) return p;
  return path.join(projectRoot, p.replace(/^\.\//, ""));
}

export function getIciciCorporateConfig() {
  const envType = String(process.env.ICICI_CORPORATE_ENV || process.env.ENV_TYPE || "UAT").toUpperCase();
  const isProd = envType === "PROD" || envType === "PRODUCTION";

  const baseUrl =
    process.env.ICICI_CORPORATE_BASE_URL ||
    (isProd
      ? "https://apibankingone.icicibank.com"
      : "https://apibankingonesandbox.icicibank.com");

  return {
    envType,
    isProd,
    baseUrl,
    apiPrefix: process.env.ICICI_CORPORATE_API_PREFIX || "/api/Corporate/CIB/v1",
    corpId: process.env.ICICI_CORPORATE_ID || "",
    userId: process.env.ICICI_CORPORATE_USER_ID || "",
    aggregatorId: process.env.ICICI_AGGREGATOR_ID || "",
    accountNumber: process.env.ICICI_ACCOUNT_ID || process.env.ICICI_ACCOUNT_NUMBER || "",
    apiKey: process.env.ICICI_CORPORATE_API_KEY || "",
    clientId: process.env.ICICI_CORPORATE_CLIENT_ID || "",
    useStub: String(process.env.ICICI_CORPORATE_USE_STUB || "false").toLowerCase() === "true",
    useHttp: String(process.env.ICICI_CORPORATE_USE_HTTP || "true").toLowerCase() === "true",
    requestTimeoutMs: Number(process.env.ICICI_CORPORATE_TIMEOUT_MS || 60000),
    retryAttempts: Number(process.env.ICICI_CORPORATE_RETRY_ATTEMPTS || 3),
    retryDelayMs: Number(process.env.ICICI_CORPORATE_RETRY_DELAY_MS || 1500),
    statementMaxRangeDays: Number(process.env.ICICI_STATEMENT_MAX_RANGE_DAYS || 90),
    keys: {
      privateKeyPath: resolveBankingPath(
        process.env.ICICI_PRIVATE_KEY_PATH || "config/certs/private.key"
      ),
      publicCertPath: resolveBankingPath(
        process.env.ICICI_PUBLIC_CERT_PATH || "config/certs/public.crt"
      ),
      iciciPublicCertPath: resolveBankingPath(
        process.env.ICICI_BANK_PUBLIC_CERT_PATH || "config/certs/icici_public.crt"
      ),
    },
    endpoints: {
      registration: process.env.ICICI_REGISTRATION_PATH || "/Registration",
      statement: process.env.ICICI_STATEMENT_PATH || "/AccountStatement",
      transactionStatus: process.env.ICICI_TXN_STATUS_PATH || "/TransactionStatus",
      balance: process.env.ICICI_BALANCE_PATH || "/BalanceInquiry",
    },
    ipWhitelist: (process.env.ICICI_IP_WHITELIST || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    cron: {
      enabled: String(process.env.ICICI_BANKING_CRON_ENABLED || "false").toLowerCase() === "true",
      schedule: process.env.ICICI_BANKING_CRON || "0 6 * * *",
      timezone: process.env.FINANCE_CRON_TZ || "Asia/Kolkata",
      lookbackDays: Number(process.env.ICICI_BANKING_LOOKBACK_DAYS || 3),
    },
  };
}

export function assertCorporateConfig(requireRegistration = false) {
  const cfg = getIciciCorporateConfig();
  if (cfg.useStub) return cfg;

  const missing = [];
  if (!cfg.corpId) missing.push("ICICI_CORPORATE_ID");
  if (!cfg.userId) missing.push("ICICI_CORPORATE_USER_ID");
  if (!cfg.accountNumber) missing.push("ICICI_ACCOUNT_ID");
  if (requireRegistration && !cfg.apiKey && !cfg.clientId) {
    missing.push("ICICI_CORPORATE_API_KEY or ICICI_CORPORATE_CLIENT_ID");
  }

  if (missing.length) {
    const err = new Error(`Missing ICICI Corporate config: ${missing.join(", ")}`);
    err.code = "ICICI_CORPORATE_CONFIG";
    throw err;
  }
  return cfg;
}
