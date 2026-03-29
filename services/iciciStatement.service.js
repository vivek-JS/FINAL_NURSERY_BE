/**
 * ICICI Account Services — bank statement fetch via SDK (SdkClient.execute).
 * Set ICICI_STATEMENT_API_ID from sdk-api-config.json (corporate / account module row).
 * ENV_TYPE=UAT for sandbox.
 */

import crypto from "crypto";
import { SdkClient } from "@icici/eazypay";
import {
  getEazypayLogger,
  assertEazypayFilesPresent,
  readSdkConfigJson,
} from "../config/eazypaySdk.js";
import BankStatementEntry from "../models/bankStatementEntry.model.js";

const log = () => getEazypayLogger();

/**
 * Normalise one ICICI statement row — field names may differ by SDK version.
 */
export function normaliseStatementRow(raw, index = 0) {
  const r = raw || {};
  const txnDate =
    r.txnDate ||
    r.transactionDate ||
    r.transactionDateTime ||
    r.date ||
    r.valueDate ||
    new Date();
  const amount = Number(
    r.amount ?? r.creditAmount ?? r.debitAmount ?? r.txnAmount ?? 0
  );
  const referenceNumber = String(
    r.referenceNumber ?? r.reference ?? r.utr ?? r.rrn ?? ""
  ).trim();
  const narration = String(r.narration ?? r.description ?? r.remark ?? "");
  const txnType = String(r.txnType ?? r.type ?? r.transactionType ?? "");
  const balance = r.balance != null ? Number(r.balance) : undefined;
  const transactionId = String(r.transactionId ?? r.txnId ?? "").trim();
  const chequeNumber = String(r.chequeNumber ?? r.chequeNo ?? "").trim();

  const d = txnDate instanceof Date ? txnDate : new Date(txnDate);
  const entryHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        d: d.toISOString().slice(0, 10),
        amount: Math.round(amount * 100) / 100,
        referenceNumber,
        narration: narration.slice(0, 200),
        index,
      })
    )
    .digest("hex");

  return {
    txnDate: d,
    amount: Math.round(amount * 100) / 100,
    referenceNumber,
    narration,
    txnType,
    balance,
    transactionId,
    chequeNumber,
    entryHash,
    rawResponse: raw,
  };
}

function stubStatementRows(fromDate, toDate) {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  log().info("Using stub bank statement rows (ICICI_STATEMENT_USE_STUB=true)");
  return [
    {
      txnDate: from,
      amount: 100.5,
      referenceNumber: "STUBUTR001",
      narration: "UPI/CR STUB",
      txnType: "CREDIT",
      balance: 100000,
      transactionId: "",
      chequeNumber: "",
      entryHash: crypto
        .createHash("sha256")
        .update(`stub-${from.toISOString()}-1`)
        .digest("hex"),
      rawResponse: { stub: true },
    },
  ];
}

/**
 * Call ICICI SDK for statement. Assumption: module may be corporate or account — set ICICI_STATEMENT_MODULE env.
 */
export async function fetchStatementFromSdk(fromDate, toDate) {
  if (process.env.ICICI_STATEMENT_USE_STUB === "true") {
    return stubStatementRows(fromDate, toDate);
  }

  assertEazypayFilesPresent();

  if (process.env.EAZYPAY_USE_STUB !== "true") {
    if (!process.env.ICICI_STATEMENT_API_ID?.trim()) {
      const e = new Error(
        "ICICI_STATEMENT_API_ID missing — copy statement API apiId from sdk-api-config.json"
      );
      e.code = "ICICI_STATEMENT_CONFIG";
      throw e;
    }
  }

  const from = new Date(fromDate);
  const to = new Date(toDate);
  const moduleName = process.env.ICICI_STATEMENT_MODULE || "corporate";
  const apiId = process.env.ICICI_STATEMENT_API_ID || "STUB_STATEMENT_API";

  const request = {
    fromDate: from.toISOString().slice(0, 10),
    toDate: to.toISOString().slice(0, 10),
    accountId: process.env.ICICI_ACCOUNT_ID || process.env.EAZYPAY_MERCHANT_ID,
  };

  try {
    readSdkConfigJson();
  } catch (e) {
    log().warn("sdk-api-config read skipped");
  }

  let sdkResult;
  try {
    sdkResult = await SdkClient.execute({
      module: moduleName,
      moduleName,
      apiId,
      request,
    });
  } catch (err) {
    log().error("Statement SdkClient.execute failed", { message: err?.message });
    throw err;
  }

  const rows = extractStatementArray(sdkResult);
  return rows.map((row, i) => normaliseStatementRow(row, i));
}

function extractStatementArray(sdkResult) {
  const root = sdkResult?.data ?? sdkResult?.response ?? sdkResult?.body ?? sdkResult;
  const inner = root?.data ?? root;
  if (Array.isArray(inner)) return inner;
  if (Array.isArray(inner?.transactions)) return inner.transactions;
  if (Array.isArray(inner?.statement)) return inner.statement;
  if (Array.isArray(inner?.entries)) return inner.entries;
  return [];
}

/**
 * Persist normalised rows; skip duplicates by entryHash.
 */
export async function persistStatementEntries(entries) {
  let inserted = 0;
  let skipped = 0;
  for (const e of entries) {
    try {
      await BankStatementEntry.create({
        txnDate: e.txnDate,
        amount: e.amount,
        referenceNumber: e.referenceNumber,
        narration: e.narration,
        txnType: e.txnType,
        balance: e.balance,
        transactionId: e.transactionId,
        chequeNumber: e.chequeNumber,
        entryHash: e.entryHash,
        rawResponse: e.rawResponse,
      });
      inserted += 1;
    } catch (err) {
      if (err.code === 11000) skipped += 1;
      else throw err;
    }
  }
  return { inserted, skipped, total: entries.length };
}

/**
 * Fetch from SDK and persist in one step.
 */
export async function fetchAndStoreBankStatement(fromDate, toDate) {
  const rows = await fetchStatementFromSdk(fromDate, toDate);
  const persist = await persistStatementEntries(rows);
  return { ...persist, entries: rows };
}

/**
 * Load stored entries for reconciliation (credit side — positive amounts for matching).
 */
export async function getStoredEntriesForRange(dateFrom, dateTo) {
  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  to.setHours(23, 59, 59, 999);
  return BankStatementEntry.find({
    txnDate: { $gte: from, $lte: to },
  })
    .lean()
    .exec();
}
