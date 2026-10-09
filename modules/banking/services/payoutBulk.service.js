/**
 * Bulk operations for payouts and the payee register:
 *
 *   - Excel upload: rows are checked one by one with the same rules as a single
 *     payment/payee. `dryRun` returns the per-row verdict without saving; the
 *     commit creates every valid row (all payouts of one upload share a batch).
 *   - Bulk approve / reject: each item goes through the normal approve/reject,
 *     so every rule (roles, self-approval, payee still active, state) still
 *     applies per item. Approvals are sent to ICICI one at a time, spaced out,
 *     because ICICI allows only 1–2 requests per second.
 */

import crypto from "crypto";
import IciciBeneficiary from "../models/iciciBeneficiary.model.js";
import { PAYOUT_PURPOSES } from "../models/iciciPayout.model.js";
import { getIciciCorporateConfig } from "../config/iciciCorporate.config.js";
import {
  PayoutError,
  approvePayout,
  duplicateMessage,
  insertPayout,
  preparePayout,
  rejectPayout,
  userName,
} from "./iciciPayout.service.js";
import {
  approveBeneficiary,
  bankKindOf,
  rejectBeneficiary,
  validateBeneficiaryInput,
} from "./iciciBeneficiary.service.js";

export const BULK_UPLOAD_MAX_ROWS = 500;
export const BULK_APPROVE_MAX = 25;
export const BULK_DECIDE_MAX = 200;
const BANK_GAP_MS = 600;

const MODE_ALIASES = {
  NEFT: "RGS",
  RGS: "RGS",
  RTGS: "RTG",
  RTG: "RTG",
  IMPS: "IFS",
  IFS: "IFS",
  TPA: "TPA",
  FT: "TPA",
  ICICI: "TPA",
  "ICICI TO ICICI": "TPA",
  "ICICI-ICICI": "TPA",
  "INTERNAL TRANSFER": "TPA",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (v) => (v == null ? "" : String(v).trim());
const code = (v) => text(v).toUpperCase().replace(/[\s-]+/g, "_");

export function normaliseMode(value) {
  const key = text(value).toUpperCase().replace(/\s+/g, " ");
  return MODE_ALIASES[key] || key;
}

function normalisePurpose(value) {
  const c = code(value);
  if (!c) return "OTHER";
  if (PAYOUT_PURPOSES.includes(c)) return c;
  const loose = { VENDOR: "VENDOR_BILL", BILL: "VENDOR_BILL", REFUND: "FARMER_REFUND", COMMISSION: "DEALER_COMMISSION" };
  return loose[c] || c;
}

function normaliseBankKind(value) {
  const c = code(value);
  if (!c) return "";
  if (c === "ICICI" || c === "ICICI_BANK") return "ICICI";
  return "NON_ICICI";
}

/** Map a spreadsheet row (template headers or API keys) to payout input. */
export function payoutRowToInput(row = {}) {
  return {
    payeeName: text(row.payeeName ?? row.name),
    accountNumber: text(row.accountNumber),
    ifsc: text(row.ifsc),
    bankName: text(row.bankName),
    payeeType: code(row.payeeType ?? row.type) || "VENDOR",
    txnType: normaliseMode(row.txnType ?? row.mode),
    amount: text(row.amount).replace(/[,₹\s]/g, ""),
    purpose: normalisePurpose(row.purpose),
    referenceNo: text(row.referenceNo),
    remarks: text(row.remarks),
  };
}

export function beneficiaryRowToInput(row = {}) {
  return {
    name: text(row.name ?? row.payeeName),
    accountNumber: text(row.accountNumber),
    ifsc: text(row.ifsc),
    bankName: text(row.bankName),
    bankKind: normaliseBankKind(row.bankKind ?? row.bank),
    type: code(row.type ?? row.payeeType) || "VENDOR",
    nickname: text(row.nickname),
    mobile: text(row.mobile),
  };
}

function newBatch(name) {
  const d = new Date();
  const stamp = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const id = `B${stamp}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  return { id, name: text(name).slice(0, 80) || `Upload ${d.toISOString().slice(0, 16).replace("T", " ")}` };
}

function checkRowCount(rows, max) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new PayoutError("The file has no rows", "VALIDATION", { errors: { rows: "No rows" } });
  }
  if (rows.length > max) {
    throw new PayoutError(`At most ${max} rows per upload`, "VALIDATION", { errors: { rows: `Max ${max}` } });
  }
}

/** Approved payee with this account (and IFSC, or any ICICI branch for ICICI to ICICI). */
async function findRegisteredPayee(input) {
  const account = input.accountNumber.replace(/\s+/g, "").toUpperCase();
  if (!account) return null;
  const ifsc = input.ifsc.toUpperCase();
  const candidates = await IciciBeneficiary.find({ accountNumber: account, status: "ACTIVE" }).lean();
  if (input.txnType === "TPA") return candidates.find((b) => b.bankKind === "ICICI") || null;
  return candidates.find((b) => b.ifsc === ifsc) || null;
}

/**
 * Check (dryRun) or create payouts from spreadsheet rows.
 *
 * Row verdicts: `ok` (can be created), `warning` (possible duplicate — created
 * only with confirmDuplicates), `error` (never created).
 */
export async function bulkCreatePayouts(rows, user, { dryRun = true, confirmDuplicates = false, batchName } = {}) {
  checkRowCount(rows, BULK_UPLOAD_MAX_ROWS);
  const cfg = getIciciCorporateConfig();
  const seen = new Map();
  const results = [];

  for (let i = 0; i < rows.length; i += 1) {
    const input = payoutRowToInput(rows[i]);
    const result = {
      row: i + 1,
      payeeName: input.payeeName,
      accountNumber: input.accountNumber,
      amount: Number(input.amount) || null,
      txnType: input.txnType,
    };
    try {
      const registered = await findRegisteredPayee(input);
      if (registered) {
        input.beneficiaryId = registered._id;
        result.registeredPayee = registered.name;
      }
      const { value, duplicate } = await preparePayout(input, cfg);
      result.value = value;
      result.payeeName = value.payee.name;
      result.amount = value.amount;
      result.warnings = [];
      if (registered && input.payeeName && input.payeeName.toUpperCase() !== registered.name.toUpperCase()) {
        result.warnings.push(`Paid to the approved payee "${registered.name}" (file says "${input.payeeName}")`);
      }
      const key = `${value.payee.accountNumber}|${value.amount}`;
      if (seen.has(key)) result.duplicate = `Same account and amount as row ${seen.get(key)}`;
      else if (duplicate) result.duplicate = duplicateMessage(duplicate);
      seen.set(key, seen.get(key) || i + 1);
      result.verdict = result.duplicate ? "warning" : "ok";
    } catch (err) {
      if (!(err instanceof PayoutError)) throw err;
      result.verdict = "error";
      result.errors = err.errors || { row: err.message };
    }
    results.push(result);
  }

  const creatable = results.filter((r) => r.verdict === "ok" || (r.verdict === "warning" && confirmDuplicates));
  const summary = {
    total: results.length,
    ok: results.filter((r) => r.verdict === "ok").length,
    warnings: results.filter((r) => r.verdict === "warning").length,
    errors: results.filter((r) => r.verdict === "error").length,
    creatable: creatable.length,
    creatableAmount: creatable.reduce((s, r) => s + (r.amount || 0), 0),
  };

  if (dryRun) {
    return { dryRun: true, summary, rows: results.map(({ value, ...r }) => r) };
  }
  if (!creatable.length) {
    throw new PayoutError("No rows can be created — fix the errors and upload again", "VALIDATION", {
      errors: { rows: "Nothing to create" },
    });
  }

  const batch = newBatch(batchName);
  for (const r of creatable) {
    const note = [
      `Excel upload ${batch.name}, row ${r.row}`,
      r.duplicate ? `created despite: ${r.duplicate}` : "",
    ]
      .filter(Boolean)
      .join(" — ");
    const doc = await insertPayout(r.value, user, { cfg, note, batch });
    r.created = { _id: doc._id, uniqueId: doc.uniqueId };
  }
  return {
    dryRun: false,
    batch,
    summary: { ...summary, created: creatable.length },
    rows: results.map(({ value, ...r }) => r),
  };
}

/** Check (dryRun) or create payees from spreadsheet rows; duplicates are errors. */
export async function bulkCreateBeneficiaries(rows, user, { dryRun = true } = {}) {
  checkRowCount(rows, BULK_UPLOAD_MAX_ROWS);
  const cfg = getIciciCorporateConfig();
  const seen = new Map();
  const results = [];

  for (let i = 0; i < rows.length; i += 1) {
    const input = beneficiaryRowToInput(rows[i]);
    const check = validateBeneficiaryInput(input, { debitAccount: cfg.accountNumber });
    const result = { row: i + 1, name: input.name, accountNumber: input.accountNumber, ifsc: input.ifsc.toUpperCase() };
    if (!check.ok) {
      results.push({ ...result, verdict: "error", errors: check.errors });
      continue;
    }
    const v = check.value;
    const key = `${v.accountNumber}|${v.ifsc}`;
    if (seen.has(key)) {
      results.push({ ...result, verdict: "error", errors: { accountNumber: `Same account and IFSC as row ${seen.get(key)}` } });
      continue;
    }
    seen.set(key, i + 1);
    const existing = await IciciBeneficiary.findOne({ dedupeKey: key }).select("name status").lean();
    if (existing) {
      const state = existing.status === "ACTIVE" ? "approved" : "awaiting approval";
      results.push({ ...result, verdict: "error", errors: { accountNumber: `Already registered as ${existing.name} (${state})` } });
      continue;
    }
    results.push({ ...result, verdict: "ok", bankKind: bankKindOf(v.ifsc), value: v });
  }

  const creatable = results.filter((r) => r.verdict === "ok");
  const summary = {
    total: results.length,
    ok: creatable.length,
    errors: results.length - creatable.length,
    creatable: creatable.length,
  };
  if (dryRun) return { dryRun: true, summary, rows: results.map(({ value, ...r }) => r) };
  if (!creatable.length) {
    throw new PayoutError("No rows can be created — fix the errors and upload again", "VALIDATION", {
      errors: { rows: "Nothing to create" },
    });
  }

  for (const r of creatable) {
    const doc = new IciciBeneficiary({
      ...r.value,
      dedupeKey: `${r.value.accountNumber}|${r.value.ifsc}`,
      status: "PENDING_APPROVAL",
      makerId: user._id,
      makerName: userName(user),
      history: [
        {
          at: new Date(),
          action: "CREATED",
          toStatus: "PENDING_APPROVAL",
          by: user._id,
          byName: userName(user),
          note: `Excel upload, row ${r.row}`,
        },
      ],
    });
    try {
      await doc.save();
      r.created = { _id: doc._id };
    } catch (err) {
      if (err?.code !== 11000) throw err;
      r.verdict = "error";
      r.errors = { accountNumber: "Registered by someone else meanwhile" };
    }
  }
  const created = creatable.filter((r) => r.created).length;
  return { dryRun: false, summary: { ...summary, created }, rows: results.map(({ value, ...r }) => r) };
}

function checkIds(ids, max) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
  if (!list.length) throw new PayoutError("Select at least one item", "VALIDATION", { errors: { ids: "Required" } });
  if (list.length > max) throw new PayoutError(`At most ${max} at a time`, "VALIDATION", { errors: { ids: `Max ${max}` } });
  return list;
}

async function eachItem(ids, fn, { gapMs = 0 } = {}) {
  const items = [];
  for (let i = 0; i < ids.length; i += 1) {
    if (i > 0 && gapMs) await sleep(gapMs);
    try {
      const doc = await fn(ids[i]);
      items.push({ id: ids[i], ok: true, status: doc.status, uniqueId: doc.uniqueId, name: doc.payee?.name || doc.name });
    } catch (err) {
      if (!(err instanceof PayoutError)) throw err;
      items.push({ id: ids[i], ok: false, code: err.code, error: err.message });
    }
  }
  return { items, done: items.filter((x) => x.ok).length, failed: items.filter((x) => !x.ok).length };
}

/** Approve several payouts; each is sent to ICICI in turn. */
export async function bulkApprovePayouts(ids, user, { note } = {}) {
  const list = checkIds(ids, BULK_APPROVE_MAX);
  const gapMs = getIciciCorporateConfig().useStub ? 0 : BANK_GAP_MS;
  return eachItem(list, (id) => approvePayout(id, user, { note }), { gapMs });
}

export async function bulkRejectPayouts(ids, user, { reason } = {}) {
  if (!text(reason)) throw new PayoutError("Give a reason for rejecting", "VALIDATION", { errors: { reason: "Required" } });
  const list = checkIds(ids, BULK_DECIDE_MAX);
  return eachItem(list, (id) => rejectPayout(id, user, { reason }));
}

export async function bulkApproveBeneficiaries(ids, user, { note } = {}) {
  const list = checkIds(ids, BULK_DECIDE_MAX);
  return eachItem(list, (id) => approveBeneficiary(id, user, { note }));
}

export async function bulkRejectBeneficiaries(ids, user, { reason } = {}) {
  if (!text(reason)) throw new PayoutError("Give a reason for rejecting", "VALIDATION", { errors: { reason: "Required" } });
  const list = checkIds(ids, BULK_DECIDE_MAX);
  return eachItem(list, (id) => rejectBeneficiary(id, user, { reason }));
}
