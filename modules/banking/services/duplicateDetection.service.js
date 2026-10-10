import crypto from "crypto";
import BankStatementEntry from "../../../models/bankStatementEntry.model.js";
import { normalizeUtr, normalizeAmount } from "../../../services/iciciBankService.js";

/**
 * Build composite duplicate key: account + UTR + amount + date
 */
export function buildDuplicateKey({ accountNumber, referenceNumber, amount, txnDate }) {
  const d = txnDate instanceof Date ? txnDate : new Date(txnDate);
  const dateStr = d.toISOString().slice(0, 10);
  const utr = normalizeUtr(referenceNumber);
  const amt = normalizeAmount(amount);
  const acct = String(accountNumber || "DEFAULT").trim();

  return crypto
    .createHash("sha256")
    .update(`${acct}|${utr}|${amt}|${dateStr}`)
    .digest("hex");
}

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Calendar day of a line in India time (bank dates arrive as UTC midnight of the bank day). */
export function bankDay(value) {
  const d = value instanceof Date ? value : new Date(value);
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

const narrationKey = (s) =>
  String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 120);

/** The fields that identify a statement line, normalised for comparison. */
export function lineSignature(e) {
  return {
    account: String(e.accountNumber || "").trim(),
    paise: Math.round(Number(e.amount || 0) * 100),
    day: bankDay(e.txnDate),
    txnId: String(e.transactionId || "").trim().toUpperCase(),
    utr: normalizeUtr(e.referenceNumber || e.utr || ""),
    narr: narrationKey(e.narration),
  };
}

function sameNarration(a, b) {
  if (!a || !b) return true;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * Is `a` the same bank line as `b`?
 *  1. Both carry ICICI's transaction id → that decides (with the amount).
 *  2. Same amount and day, and the same UTR — or the UTR of one appears in
 *     the other's narration (a CSV without a reference column).
 *  3. Neither has a reference: same amount, day and narration.
 */
export function isSameLine(a, b) {
  if (a.paise !== b.paise) return false;
  if (a.txnId && b.txnId) return a.txnId === b.txnId;
  if (a.day !== b.day) return false;
  if (a.utr && b.utr) return a.utr === b.utr;
  if (a.utr || b.utr) {
    const ref = a.utr || b.utr;
    const other = a.utr ? b.narr : a.narr;
    return Boolean(ref) && other.includes(ref);
  }
  return sameNarration(a.narr, b.narr);
}

const hasReference = (s) => Boolean(s.txnId || s.utr);

function storageKey(sig, occurrence, entry) {
  if (sig.txnId) return sha(`T|${sig.account || "DEFAULT"}|${sig.txnId}|${sig.paise}`);
  if (sig.utr) {
    return buildDuplicateKey({
      accountNumber: entry.accountNumber,
      referenceNumber: entry.referenceNumber || entry.utr,
      amount: entry.amount,
      txnDate: entry.txnDate,
    });
  }
  return sha(`N|${sig.account || "DEFAULT"}|${sig.day}|${sig.paise}|${sig.narr}|${occurrence}`);
}

async function loadExisting(account, entries) {
  const times = entries.map((e) => new Date(e.txnDate).getTime()).filter(Number.isFinite);
  if (!times.length) return new Map();
  const rows = await BankStatementEntry.find({
    accountNumber: { $in: [...new Set([account, ""])] },
    txnDate: { $gte: new Date(Math.min(...times) - 2 * DAY_MS), $lte: new Date(Math.max(...times) + 2 * DAY_MS) },
  })
    .select("accountNumber amount txnDate utr referenceNumber transactionId narration")
    .lean();
  const byAmount = new Map();
  for (const r of rows) {
    const item = { sig: lineSignature(r), claimed: false };
    if (!byAmount.has(item.sig.paise)) byAmount.set(item.sig.paise, []);
    byAmount.get(item.sig.paise).push(item);
  }
  return byAmount;
}

/**
 * Save statement lines that are not in the system yet.
 *
 * Each incoming line is compared with the lines already saved (and with the
 * earlier lines of this batch), so syncing the same day again only adds what
 * is new — also against lines saved before this check existed. Lines with no
 * reference are kept apart by how many identical ones exist: two separate
 * ₹500 cash deposits on one day stay two lines, and re-syncing adds neither.
 * The unique keys on the collection still guard against two syncs at once.
 */
export async function safeInsertBankTransactions(entries) {
  const list = (entries || []).filter((e) => e && e.txnDate && Number.isFinite(Number(e.amount)));
  if (!list.length) return { inserted: 0, skipped: 0, alreadySaved: 0, total: 0, duplicates: [] };

  const byAccount = new Map();
  list.forEach((e, index) => {
    const acct = String(e.accountNumber || "").trim();
    if (!byAccount.has(acct)) byAccount.set(acct, []);
    byAccount.get(acct).push({ e, index, sig: lineSignature(e) });
  });

  const docs = [];
  const duplicates = [];
  let alreadySaved = 0;
  let repeatedInBatch = 0;

  for (const [account, items] of byAccount) {
    const existingByAmount = await loadExisting(account, items.map((x) => x.e));
    const acceptedByAmount = new Map();
    for (const { e, index, sig } of items) {
      const existing = existingByAmount.get(sig.paise) || [];
      if (!acceptedByAmount.has(sig.paise)) acceptedByAmount.set(sig.paise, []);
      const accepted = acceptedByAmount.get(sig.paise);
      const match = existing.find((x) => !x.claimed && isSameLine(sig, x.sig));
      if (match) {
        match.claimed = true;
        alreadySaved += 1;
        duplicates.push({ index, reason: "already saved" });
        continue;
      }
      if (hasReference(sig) && accepted.some((x) => isSameLine(sig, x.sig))) {
        repeatedInBatch += 1;
        duplicates.push({ index, reason: "repeated in this batch" });
        continue;
      }
      const occurrence = hasReference(sig)
        ? 0
        : existing.filter((x) => !hasReference(x.sig) && isSameLine(sig, x.sig)).length +
          accepted.filter((x) => !hasReference(x.sig) && isSameLine(sig, x.sig)).length;
      const duplicateKey = storageKey(sig, occurrence, e);
      accepted.push({ sig });
      docs.push({
        txnDate: e.txnDate,
        amount: e.amount,
        referenceNumber: e.referenceNumber || "",
        narration: e.narration || "",
        txnType: e.txnType || "",
        balance: e.balance,
        transactionId: e.transactionId || "",
        chequeNumber: e.chequeNumber || "",
        entryHash: sha(`E|${duplicateKey}`),
        duplicateKey,
        accountNumber: e.accountNumber || "",
        utr: normalizeUtr(e.referenceNumber),
        source: e.source || "CORPORATE_HTTP",
        reconciliationStatus: "UNMATCHED",
        rawResponse: e.rawResponse,
      });
    }
  }

  let inserted = docs.length;
  let raced = 0;
  if (docs.length) {
    try {
      await BankStatementEntry.insertMany(docs, { ordered: false });
    } catch (err) {
      const duplicateError =
        err.code === 11000 ||
        err.name === "MongoBulkWriteError" ||
        (Array.isArray(err.writeErrors) && err.writeErrors.some((w) => w.code === 11000));
      if (!duplicateError) throw err;
      inserted = err.result?.insertedCount ?? err.insertedCount ?? 0;
      raced = docs.length - inserted;
    }
  }

  return {
    inserted,
    skipped: alreadySaved + repeatedInBatch + raced,
    alreadySaved: alreadySaved + raced,
    repeatedInBatch,
    total: list.length,
    duplicates: duplicates.slice(0, 20),
  };
}

export async function findDuplicateByComposite({ accountNumber, utr, amount, txnDate }) {
  const duplicateKey = buildDuplicateKey({
    accountNumber,
    referenceNumber: utr,
    amount,
    txnDate,
  });
  return BankStatementEntry.findOne({ duplicateKey }).lean();
}
