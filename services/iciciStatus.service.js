/**
 * ICICI EazyPay — payment / transaction status via SdkClient.execute (module eazypay).
 * Set EAZYPAY_STATUS_API_ID from sdk-api-config.json (status enquiry row).
 */

import { SdkClient } from "@icici/eazypay";
import {
  getEazypayLogger,
  assertEazypayFilesPresent,
  readSdkConfigJson,
} from "../config/eazypaySdk.js";

const log = () => getEazypayLogger();

/**
 * Map ICICI response to internal status for ERP.
 */
export function mapIciciStatusToInternal(inner) {
  const code =
    inner?.respCode ??
    inner?.responseCode ??
    inner?.statusCode ??
    inner?.transactionStatus ??
    "";
  const desc = String(inner?.respDesc ?? inner?.status ?? "").toUpperCase();
  const c = String(code).trim();

  if (
    c === "00" ||
    desc.includes("SUCCESS") ||
    desc.includes("COMPLETED") ||
    inner?.status === "SUCCESS"
  ) {
    return { status: "SUCCESS", raw: inner };
  }
  if (desc.includes("FAIL") || c === "01" || inner?.status === "FAILED") {
    return { status: "FAILED", raw: inner };
  }
  if (desc.includes("EXPIR") || inner?.status === "EXPIRED") {
    return { status: "EXPIRED", raw: inner };
  }
  return { status: "PENDING", raw: inner };
}

/**
 * Check payment status for a merchantTranId (QR flow).
 */
export async function checkPaymentStatus(merchantTranId) {
  if (!merchantTranId || String(merchantTranId).trim() === "") {
    const e = new Error("merchantTranId is required");
    e.code = "VALIDATION";
    throw e;
  }

  if (process.env.EAZYPAY_USE_STUB === "true") {
    return {
      status: "PENDING",
      merchantTranId,
      providerTxnId: null,
      amount: null,
      raw: { stub: true },
    };
  }

  assertEazypayFilesPresent();

  if (!process.env.EAZYPAY_STATUS_API_ID?.trim()) {
    const e = new Error(
      "EAZYPAY_STATUS_API_ID missing — copy status API apiId from sdk-api-config.json (eazypay module)"
    );
    e.code = "EAZYPAY_CONFIG";
    throw e;
  }

  try {
    readSdkConfigJson();
  } catch (e) {
    log().warn("sdk-api-config read skipped");
  }

  const merchantId = process.env.EAZYPAY_MERCHANT_ID;
  const terminalId = process.env.EAZYPAY_TERMINAL_ID;
  const request = {
    merchantId,
    terminalId,
    merchantTranId: String(merchantTranId).trim(),
  };

  const apiId = process.env.EAZYPAY_STATUS_API_ID;

  let sdkResult;
  try {
    sdkResult = await SdkClient.execute({
      module: "eazypay",
      moduleName: "eazypay",
      apiId,
      request,
    });
  } catch (err) {
    log().error("Status SdkClient.execute failed", { message: err?.message });
    throw err;
  }

  const root = sdkResult?.data ?? sdkResult?.response ?? sdkResult?.body ?? sdkResult;
  const inner = root?.data ?? root;
  const mapped = mapIciciStatusToInternal(inner);

  const providerTxnId =
    inner?.providerTxnId ??
    inner?.bankTransactionId ??
    inner?.rrn ??
    inner?.txnId ??
    null;
  const amount =
    inner?.amount != null
      ? String(inner.amount)
      : inner?.txnAmount != null
        ? String(inner.txnAmount)
        : null;

  return {
    status: mapped.status,
    merchantTranId,
    providerTxnId,
    amount,
    raw: sdkResult,
  };
}
