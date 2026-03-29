/**
 * ICICI EazyPay — dynamic QR generation via official SDK (SdkClient.execute).
 * Assumption: Your SDK version may use slightly different parameter names for execute();
 * adjust the call once against the integration guide (e.g. moduleName vs module).
 */

import { SdkClient } from "@icici/eazypay";
import {
  getEazypayLogger,
  assertEazypayFilesPresent,
  readSdkConfigJson,
} from "../config/eazypaySdk.js";
import { generateMerchantTranId } from "../utils/merchantTranId.js";
import IciciQrTransaction from "../models/iciciQrTransaction.model.js";

const log = () => getEazypayLogger();

/**
 * Format amount for ICICI (two decimal string).
 */
export function formatAmountString(amount) {
  const n = Number(amount);
  if (Number.isNaN(n) || n <= 0) throw new Error("Invalid amount");
  return n.toFixed(2);
}

/**
 * Pick QR / UPI string from SDK response (field names differ by API version).
 */
function extractQrFields(sdkResult) {
  const root = sdkResult?.data ?? sdkResult?.response ?? sdkResult?.body ?? sdkResult;
  const inner = root?.data ?? root;
  const qrString =
    inner?.qrString ||
    inner?.qrData ||
    inner?.upiIntent ||
    inner?.intentUrl ||
    inner?.upiUrl ||
    (typeof inner?.qr === "string" ? inner.qr : undefined);
  const qrImageBase64 = inner?.qrImageBase64 || inner?.qrImage || inner?.imageBase64;
  return { qrString, qrImageBase64, inner, raw: sdkResult };
}

/**
 * Map SDK / crypto errors to stable codes for the controller.
 */
export function normalizeIciciError(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  const code = err?.code;
  const status = err?.response?.status;

  if (code === "EAZYPAY_CONFIG") {
    return { httpStatus: 500, code, message: err.message };
  }
  if (code === "EAZYPAY_KEYSTORE_ERROR") {
    return { httpStatus: 500, code, message: err.message };
  }
  if (code === "SDK_CONFIG_NOT_SUBSCRIBED") {
    return { httpStatus: 502, code, message: err.message };
  }
  if (code === "VALIDATION") {
    return { httpStatus: 400, code, message: err.message };
  }
  if (status === 401 || msg.includes("401") || msg.includes("unauthorized")) {
    return {
      httpStatus: 401,
      code: "EAZYPAY_UNAUTHORIZED",
      message:
        "ICICI returned unauthorized — check EAZYPAY_API_KEY in .env and sdk-api-config.json, and that this API is subscribed in the bank portal.",
    };
  }
  if (
    msg.includes("decrypt") ||
    msg.includes("bad decrypt") ||
    msg.includes("mac invalid") ||
    msg.includes("wrong password") ||
    msg.includes("keystore")
  ) {
    return {
      httpStatus: 502,
      code: "EAZYPAY_CRYPTO_ERROR",
      message: "Encryption/decryption or keystore error — verify keystore path, alias, password, and PEM.",
    };
  }
  if (msg.includes("not subscribed") || msg.includes("subscription") || msg.includes("api id")) {
    return {
      httpStatus: 502,
      code: "SDK_CONFIG_NOT_SUBSCRIBED",
      message: err.message || "API may not be subscribed for this merchant — check sdk-api-config.json and portal.",
    };
  }
  if (msg.includes("validation") || msg.includes("required") || msg.includes("missing")) {
    return { httpStatus: 400, code: "EAZYPAY_PAYLOAD_ERROR", message: err.message };
  }

  return {
    httpStatus: 502,
    code: "EAZYPAY_SDK_ERROR",
    message: err.message || "ICICI SDK call failed",
  };
}

/**
 * Build request payload. If your bank guide names fields differently, rename here only.
 * subMerchantId: often same as merchantId for sandbox — confirm with ICICI.
 */
function buildQrRequestPayload({ orderId, amountString, merchantTranId }) {
  const merchantId = process.env.EAZYPAY_MERCHANT_ID;
  const terminalId = process.env.EAZYPAY_TERMINAL_ID;
  const subMerchantId = process.env.EAZYPAY_SUB_MERCHANT_ID || merchantId;

  if (!merchantId || !terminalId) {
    const e = new Error("EAZYPAY_MERCHANT_ID and EAZYPAY_TERMINAL_ID must be set in .env");
    e.code = "EAZYPAY_CONFIG";
    throw e;
  }

  return {
    merchantId,
    subMerchantId,
    terminalId,
    amount: amountString,
    merchantTranId,
    billNumber: orderId,
    category: "upi",
  };
}

/**
 * Call SdkClient.execute for module eazypay.
 * Assumption: apiId comes from env EAZYPAY_QR_API_ID — must match sdk-api-config.json QR API row.
 */
export async function generateIciciDynamicQr({ orderId, amount }) {
  if (process.env.ENV_TYPE && String(process.env.ENV_TYPE).toUpperCase() !== "UAT") {
    log().warn(`ENV_TYPE is ${process.env.ENV_TYPE}; sandbox docs usually expect UAT for UAT host.`);
  }

  assertEazypayFilesPresent();

  if (process.env.EAZYPAY_USE_STUB !== "true") {
    if (!process.env.EAZYPAY_API_KEY?.trim()) {
      const e = new Error("EAZYPAY_API_KEY is missing in environment");
      e.code = "EAZYPAY_CONFIG";
      throw e;
    }
    if (!process.env.EAZYPAY_QR_API_ID?.trim()) {
      const e = new Error(
        "EAZYPAY_QR_API_ID is missing — copy apiId for the QR API from config/sdk-api-config.json (eazypay module)"
      );
      e.code = "EAZYPAY_CONFIG";
      throw e;
    }
  }

  let sdkConfig;
  try {
    sdkConfig = readSdkConfigJson();
  } catch (e) {
    log().error("Failed to read sdk-api-config.json", { err: e.message });
    const err = new Error("Invalid or unreadable sdk-api-config.json");
    err.code = "SDK_CONFIG_NOT_SUBSCRIBED";
    throw err;
  }

  const merchantTranId = generateMerchantTranId("QR");
  const amountString = formatAmountString(amount);
  const requestPayload = buildQrRequestPayload({ orderId, amountString, merchantTranId });

  log().info("ICICI QR request (no secrets)", {
    merchantTranId,
    orderId,
    amount: amountString,
    configHasModules: Boolean(sdkConfig?.modules || sdkConfig?.module),
  });

  /**
   * DTO assumption: If your SDK exports request classes (see requestDtoType in sdk-api-config.json),
   * instantiate them instead of plain object, e.g.:
   *   import { QrGenerateRequestDto } from '@icici/eazypay';
   *   const dto = Object.assign(new QrGenerateRequestDto(), requestPayload);
   *   await SdkClient.execute({ ..., request: dto });
   */
  const apiId = process.env.EAZYPAY_QR_API_ID || "SET_EAZYPAY_QR_API_ID_IN_ENV";

  let sdkResult;
  try {
    sdkResult = await SdkClient.execute({
      module: "eazypay",
      moduleName: "eazypay",
      apiId,
      request: requestPayload,
    });
  } catch (err) {
    log().error("SdkClient.execute failed", { message: err?.message });
    throw err;
  }

  const { qrString, qrImageBase64, raw, inner } = extractQrFields(sdkResult);

  const expiresAt = extractExpiry(inner) || new Date(Date.now() + 30 * 60 * 1000);

  return {
    merchantTranId,
    orderId,
    amount: amountString,
    qrString,
    qrImageBase64,
    expiresAt: expiresAt.toISOString(),
    requestPayload,
    raw,
  };
}

function extractExpiry(inner) {
  const exp =
    inner?.expiresAt ||
    inner?.expiryTime ||
    inner?.validTill ||
    inner?.qrExpiry;
  if (!exp) return null;
  const d = new Date(exp);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Save one audit row in IciciQrTransaction (order payments and standalone QR).
 * Non-fatal on duplicate key or DB errors — logs only.
 */
export async function saveIciciQrAuditRecord({
  orderId,
  merchantTranId,
  amount,
  context = "STANDALONE",
  linkedOrderMongoId,
  qrPayload,
  requestPayload,
  responsePayload,
  expiresAt,
}) {
  try {
    await IciciQrTransaction.create({
      orderId,
      merchantTranId,
      amount,
      provider: "ICICI_EAZYPAY",
      status: "CREATED",
      context,
      linkedOrderMongoId,
      qrData: qrPayload,
      requestPayload,
      responsePayload,
      expiresAt,
    });
  } catch (e) {
    log().warn("saveIciciQrAuditRecord failed", { message: e.message });
  }
}
