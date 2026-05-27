import { getBankingLogger } from "./logger.js";

const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff retry for bank API calls.
 */
export async function withRetry(fn, options = {}) {
  const {
    attempts = 3,
    delayMs = 1500,
    factor = 2,
    label = "bank-api",
    onRetry,
  } = options;

  const log = getBankingLogger();
  let lastError;

  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn(i);
    } catch (err) {
      lastError = err;
      const code = err.code || err.response?.status;
      const retryable =
        RETRYABLE_CODES.has(err.code) ||
        RETRYABLE_HTTP.has(err.response?.status) ||
        String(err.message || "").toLowerCase().includes("timeout");

      if (!retryable || i === attempts) break;

      const wait = delayMs * factor ** (i - 1);
      log.warn(`${label} attempt ${i}/${attempts} failed — retry in ${wait}ms`, {
        error: err.message,
        code,
      });
      if (onRetry) onRetry(err, i, wait);
      await sleep(wait);
    }
  }

  throw lastError;
}
