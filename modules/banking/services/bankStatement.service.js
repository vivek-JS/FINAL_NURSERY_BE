import BankStatementEntry from "../../../models/bankStatementEntry.model.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

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
export async function listStatementEntries({
  accountNumber,
  dateFrom,
  dateTo,
  limit = 200,
  skip = 0,
}) {
  const { from, to } = dayRange(dateFrom, dateTo);
  const filter = { txnDate: { $gte: from, $lte: to } };
  if (accountNumber) filter.accountNumber = accountNumber;

  return BankStatementEntry.find(filter)
    .sort({ txnDate: -1, _id: -1 })
    .skip(Number(skip) || 0)
    .limit(Math.min(Number(limit) || 200, 500))
    .lean()
    .exec();
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
