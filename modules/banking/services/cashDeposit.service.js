/**
 * Manual cash deposit entry.
 *
 * Cash handed over the counter never carries a UTR, so it cannot go through the
 * UTR matcher. It is recorded against a pay-in slip and later matched to the
 * credit the bank posts for it, on amount, account and date.
 */

import CashBook from "../models/cashBook.model.js";
import BankStatementEntry, {
  NOT_STATEMENT_VERIFIED,
} from "../../../models/bankStatementEntry.model.js";
import { markStatementVerified } from "./bankStatement.service.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

const AMOUNT_EPS = 0.02;
/** A counter deposit can land on the bank's books a day or two later. */
const MATCH_WINDOW_DAYS = 2;

export async function createCashDeposit({
  entryDate,
  amount,
  accountNumber,
  slipNumber,
  narration,
  userId,
}) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: "Amount must be greater than zero" };
  }
  if (!entryDate) return { ok: false, error: "Deposit date is required" };
  if (!accountNumber) return { ok: false, error: "Bank account is required" };

  const deposit = await CashBook.create({
    entryDate: new Date(entryDate),
    entryType: "CASH_IN",
    amount: value,
    accountNumber: String(accountNumber).trim(),
    slipNumber: slipNumber ? String(slipNumber).trim() : "",
    narration: narration || "",
    reference: slipNumber ? String(slipNumber).trim() : "",
    depositVerified: false,
    depositedBy: userId || null,
    createdBy: userId || null,
  });

  log().info("Cash deposit recorded", {
    id: String(deposit._id),
    amount: value,
    accountNumber,
  });
  return { ok: true, deposit: deposit.toObject() };
}

export async function listCashDeposits({
  accountNumber,
  dateFrom,
  dateTo,
  verified,
  limit = 200,
} = {}) {
  const filter = { entryType: "CASH_IN" };
  if (accountNumber) filter.accountNumber = accountNumber;
  if (verified === true || verified === false) filter.depositVerified = verified;
  if (dateFrom || dateTo) {
    filter.entryDate = {};
    if (dateFrom) filter.entryDate.$gte = new Date(dateFrom);
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      filter.entryDate.$lte = to;
    }
  }

  return CashBook.find(filter)
    .sort({ entryDate: -1, _id: -1 })
    .limit(Math.min(Number(limit) || 200, 500))
    .lean()
    .exec();
}

/**
 * Match a recorded deposit to the bank credit for it.
 * Retires the matched statement line so it is not also offered to UTR matching.
 */
export async function verifyCashDeposit(depositId, { userId } = {}) {
  const deposit = await CashBook.findById(depositId);
  if (!deposit) return { ok: false, error: "Cash deposit not found" };
  if (deposit.entryType !== "CASH_IN") {
    return { ok: false, error: "Entry is not a cash deposit" };
  }
  if (deposit.depositVerified) {
    return { ok: true, deposit: deposit.toObject(), alreadyVerified: true };
  }

  const from = new Date(deposit.entryDate);
  from.setDate(from.getDate() - MATCH_WINDOW_DAYS);
  const to = new Date(deposit.entryDate);
  to.setDate(to.getDate() + MATCH_WINDOW_DAYS);
  to.setHours(23, 59, 59, 999);

  const candidates = await BankStatementEntry.find({
    txnDate: { $gte: from, $lte: to },
    accountNumber: deposit.accountNumber,
    reconciliationStatus: { $in: ["UNMATCHED", "SUSPENSE"] },
    ...NOT_STATEMENT_VERIFIED,
  })
    .lean()
    .exec();

  const match = candidates.find(
    (e) => e.amount > 0 && Math.abs(Number(e.amount) - Number(deposit.amount)) < AMOUNT_EPS
  );

  if (!match) {
    return {
      ok: true,
      matched: false,
      deposit: deposit.toObject(),
      message: "No matching bank credit for this deposit yet",
    };
  }

  deposit.depositVerified = true;
  deposit.depositVerifiedAt = new Date();
  deposit.verifiedAgainstEntryId = match._id;
  deposit.bankTransactionId = match._id;
  deposit.balanceAfter = match.balance;
  if (!deposit.narration) deposit.narration = match.narration || "";
  await deposit.save();

  await markStatementVerified(match._id, { userId });

  log().info("Cash deposit verified", {
    id: String(deposit._id),
    entryId: String(match._id),
    amount: deposit.amount,
  });
  return { ok: true, matched: true, deposit: deposit.toObject(), bankEntry: match };
}
