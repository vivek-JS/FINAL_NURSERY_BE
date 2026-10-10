import BankStatementEntry, { NOT_STATEMENT_VERIFIED } from "../../../models/bankStatementEntry.model.js";
import { getBankingLogger } from "../utils/logger.js";
import { safeInsertBankTransactions } from "./duplicateDetection.service.js";
import { parseStatementCsv } from "../utils/statementCsv.js";
import { normalizeAmount, normalizeUtr } from "../../../services/iciciBankService.js";

const log = () => getBankingLogger();

/** Refuse implausibly large pastes rather than letting one request exhaust memory. */
export const MAX_IMPORT_ROWS = 5000;

function dayRange(dateFrom, dateTo) {
  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

/**
 * Statement lines for the Statement tab — retired lines stay visible here as
 * history, which is why this is the one reader that does not filter them out.
 */
/**
 * Statement tab filters.
 *  - verified   : cleared by the bank match (paid UTR + amount) or marked verified by an accountant
 *  - unverified : everything still open (new, suspense, ignored)
 *  - matched    : matched to a payment by the engine
 *  - suspense   : waiting for an accountant to link
 */
export const STATEMENT_STATUS_FILTERS = ["all", "verified", "unverified", "matched", "suspense"];

const VERIFIED_CLAUSE = { $or: [{ statementVerified: true }, { reconciliationStatus: "MATCHED" }] };
const UNVERIFIED_CLAUSE = {
  statementVerified: { $ne: true },
  reconciliationStatus: { $ne: "MATCHED" },
};

function statusClause(status) {
  switch (status) {
    case "verified":
      return VERIFIED_CLAUSE;
    case "unverified":
      return UNVERIFIED_CLAUSE;
    case "matched":
      return { reconciliationStatus: "MATCHED" };
    case "suspense":
      return { reconciliationStatus: "SUSPENSE", statementVerified: { $ne: true } };
    default:
      return {};
  }
}

export async function listStatementEntries({
  accountNumber,
  dateFrom,
  dateTo,
  limit = 50,
  skip = 0,
  status = "all",
}) {
  const { from, to } = dayRange(dateFrom, dateTo);
  const base = { txnDate: { $gte: from, $lte: to } };
  if (accountNumber) base.accountNumber = accountNumber;

  const wanted = STATEMENT_STATUS_FILTERS.includes(String(status)) ? String(status) : "all";
  const filter = { ...base, ...statusClause(wanted) };

  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const offset = Math.max(Number(skip) || 0, 0);

  const [items, total, all, verified, unverified, matched, suspense] = await Promise.all([
    BankStatementEntry.find(filter)
      .sort({ txnDate: -1, _id: -1 })
      .skip(offset)
      .limit(pageSize)
      .lean()
      .exec(),
    BankStatementEntry.countDocuments(filter),
    ...["all", "verified", "unverified", "matched", "suspense"].map((k) =>
      BankStatementEntry.countDocuments({ ...base, ...statusClause(k) })
    ),
  ]);

  return {
    items,
    total,
    limit: pageSize,
    skip: offset,
    hasMore: offset + items.length < total,
    status: wanted,
    counts: { all, verified, unverified, matched, suspense },
  };
}

/**
 * Mark a page of pending ERP payments with whether a statement line already
 * has that UTR (and the same amount). The Pending tab uses this so a clerk
 * can see the match without clicking Check bank on every row.
 */
export async function matchPendingToStatement(items) {
  const rows = Array.isArray(items) ? items : [];
  const refs = [
    ...new Set(
      rows
        .map((p) => normalizeUtr(p.utrNumber || p.transactionId || p.chequeNumber || p.ref))
        .filter((r) => r && r.length >= 4)
    ),
  ];

  if (!refs.length) {
    return rows.map((p) => ({ ...p, statementMatch: "NOT_FOUND" }));
  }

  const lines = await BankStatementEntry.find({
    ...NOT_STATEMENT_VERIFIED,
    $or: [{ utr: { $in: refs } }, { referenceNumber: { $in: refs } }],
  })
    .select("utr referenceNumber amount txnDate")
    .lean()
    .exec();

  return rows.map((p) => {
    const ref = normalizeUtr(p.utrNumber || p.transactionId || p.chequeNumber || p.ref);
    if (!ref) return { ...p, statementMatch: "NOT_FOUND" };
    const hits = lines.filter(
      (l) => normalizeUtr(l.utr) === ref || normalizeUtr(l.referenceNumber) === ref
    );
    if (!hits.length) return { ...p, statementMatch: "NOT_FOUND" };
    const exact = hits.find(
      (l) => Math.abs(normalizeAmount(l.amount) - normalizeAmount(p.paidAmount)) < 0.02
    );
    if (exact) {
      return {
        ...p,
        statementMatch: "EXACT",
        statementAmount: exact.amount,
        statementTxnDate: exact.txnDate,
      };
    }
    return {
      ...p,
      statementMatch: "AMOUNT_MISMATCH",
      statementAmount: hits[0].amount,
    };
  });
}

/** Distinct account numbers seen on statement lines — feeds the account selector. */
export async function listStatementAccounts() {
  const accounts = await BankStatementEntry.distinct("accountNumber");
  return accounts.filter(Boolean).sort();
}

/**
 * Retire a statement line so matching and the queues skip it from now on.
 * Idempotent: re-verifying an already verified line is a no-op success.
 */
export async function markStatementVerified(entryId, { userId } = {}) {
  const entry = await BankStatementEntry.findById(entryId);
  if (!entry) return { ok: false, error: "Statement line not found" };

  if (entry.statementVerified) {
    return { ok: true, entry: entry.toObject(), alreadyVerified: true };
  }

  entry.statementVerified = true;
  entry.statementVerifiedAt = new Date();
  entry.statementVerifiedBy = userId || null;
  await entry.save();

  log().info("Statement line verified", {
    entryId: String(entry._id),
    amount: entry.amount,
  });
  return { ok: true, entry: entry.toObject(), alreadyVerified: false };
}

/**
 * Load statement lines an accountant exported from net banking.
 *
 * Re-running the same file is safe, and so is importing lines the API sync
 * already saved: safeInsertBankTransactions compares every line with what is
 * stored and only adds new ones. Returns counts so the caller can say what
 * actually happened.
 *
 * @param {{ csv?: string, rows?: Array, accountNumber?: string, userId?: string }} args
 */
export async function importStatementRows({ csv, rows, accountNumber, userId } = {}) {
  const account = String(accountNumber || "").trim();
  if (!account) return { ok: false, error: "Pick the bank account these lines belong to" };

  let parsed = Array.isArray(rows) ? rows : null;
  let skippedRows = [];

  if (!parsed) {
    const result = parseStatementCsv(csv);
    if (!result.ok) return { ok: false, error: result.error };
    parsed = result.rows;
    skippedRows = result.skipped;
  }

  if (!parsed.length) return { ok: false, error: "No transaction rows could be read from the file" };
  if (parsed.length > MAX_IMPORT_ROWS) {
    return {
      ok: false,
      error: `That file has ${parsed.length} rows; import at most ${MAX_IMPORT_ROWS} at a time`,
    };
  }

  const entries = parsed.map((row) => ({
    ...row,
    txnDate: row.txnDate instanceof Date ? row.txnDate : new Date(row.txnDate),
    accountNumber: account,
    source: "IMPORT",
    rawResponse: { imported: true, importedBy: userId ? String(userId) : null, at: new Date() },
  }));

  const result = await safeInsertBankTransactions(entries);
  const credits = entries.filter((e) => e.amount > 0).length;

  log().info("Statement imported", {
    account,
    inserted: result.inserted,
    skipped: result.skipped,
    userId: userId ? String(userId) : null,
  });

  return {
    ok: true,
    inserted: result.inserted,
    duplicates: result.skipped,
    total: entries.length,
    credits,
    unreadable: skippedRows,
  };
}
