import axios from "axios";
import { getIciciCorporateConfig } from "../config/iciciCorporate.config.js";
import { encryptPayload, decryptPayload } from "../crypto/rsaEncryption.js";
import { buildSignedHeaders } from "../crypto/requestSigning.js";
import { withRetry } from "../utils/retry.js";
import { getBankingLogger } from "../utils/logger.js";
import { maskSensitiveObject } from "../utils/logMasking.js";
import BankAuditLog from "../models/bankAuditLog.model.js";

const log = () => getBankingLogger();

function buildUrl(endpointPath) {
  const cfg = getIciciCorporateConfig();
  return `${cfg.baseUrl}${cfg.apiPrefix}${endpointPath}`;
}

async function writeAudit(entry) {
  try {
    await BankAuditLog.create(entry);
  } catch (e) {
    log().warn("Audit log write failed", { error: e.message });
  }
}

/**
 * Core ICICI Corporate HTTP client with hybrid encryption.
 */
export async function iciciCorporateRequest({
  endpointPath,
  payload,
  method = "POST",
  idempotencyKey,
  userId,
}) {
  const cfg = getIciciCorporateConfig();
  const url = buildUrl(endpointPath);
  const started = Date.now();

  const requestBody = cfg.useStub
    ? payload
    : encryptPayload({
        ...payload,
        corpId: cfg.corpId,
        userId: cfg.userId,
        aggregatorId: cfg.aggregatorId,
      });

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(cfg.apiKey ? { apikey: cfg.apiKey } : {}),
    ...(cfg.clientId ? { "X-IBM-Client-Id": cfg.clientId } : {}),
    ...(idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : {}),
    ...buildSignedHeaders(requestBody, process.env.ICICI_WEBHOOK_HMAC_SECRET),
  };

  log().info("ICICI Corporate request", {
    endpoint: endpointPath,
    url,
    payload: maskSensitiveObject(payload),
  });

  const execute = async () => {
    const res = await axios({
      method,
      url,
      data: requestBody,
      headers,
      timeout: cfg.requestTimeoutMs,
      validateStatus: () => true,
    });

    if (res.status >= 400) {
      const err = new Error(
        res.data?.message || res.data?.error || `ICICI HTTP ${res.status}`
      );
      err.response = res;
      err.code = res.data?.code || `ICICI_HTTP_${res.status}`;
      throw err;
    }

    let data = res.data;
    if (data?.encryptedKey && data?.encryptedData) {
      data = decryptPayload(data);
    }

    return { data, status: res.status, headers: res.headers };
  };

  try {
    const result = await withRetry(execute, {
      attempts: cfg.retryAttempts,
      delayMs: cfg.retryDelayMs,
      label: `ICICI:${endpointPath}`,
    });

    await writeAudit({
      action: endpointPath,
      direction: "OUTBOUND",
      status: "SUCCESS",
      httpStatus: result.status,
      durationMs: Date.now() - started,
      userId: userId || null,
      idempotencyKey: idempotencyKey || null,
      requestMeta: maskSensitiveObject(payload),
      responseMeta: maskSensitiveObject(
        typeof result.data === "object" ? { keys: Object.keys(result.data) } : {}
      ),
    });

    return result.data;
  } catch (err) {
    await writeAudit({
      action: endpointPath,
      direction: "OUTBOUND",
      status: "FAILED",
      httpStatus: err.response?.status,
      durationMs: Date.now() - started,
      userId: userId || null,
      idempotencyKey: idempotencyKey || null,
      requestMeta: maskSensitiveObject(payload),
      errorMessage: err.message,
      errorCode: err.code,
    });
    throw err;
  }
}

export { buildUrl };
