/**
 * Manual cash deposit entry.
 *
 * Cash handed over the counter never carries a UTR, so it cannot go through the
 * UTR matcher. It is recorded against the employee who held the cash and a
 * photographed pay-in slip, and later matched to the credit the bank posts for
 * it, on amount, account and date.
 */

import mongoose from "mongoose";
import CashBook from "../models/cashBook.model.js";
import BankStatementEntry, {
  NOT_STATEMENT_VERIFIED,
} from "../../../models/bankStatementEntry.model.js";
import { markStatementVerified } from "./bankStatement.service.js";
import { cashInHandOf, cashbookStartDate } from "./cashInHand.service.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

const AMOUNT_EPS = 0.02;
/** A counter deposit can land on the bank's books a day or two later. */
const MATCH_WINDOW_DAYS = 2;

const formatInr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

function cleanPhotos(photos) {
  const list = Array.isArray(photos) ? photos : photos ? [photos] : [];
  return list.map((p) => String(p || "").trim()).filter((p) => /^https?:\/\//i.test(p));
}

export async function createCashDeposit({
  entryDate,
  amount,
  accountNumber,
  slipNumber,
  narration,
  employeeId,
  slipPhotos,
  userId,
}) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: "Amount must be greater than zero" };
  }
  if (!entryDate) return { ok: false, error: "Deposit date is required" };
  const when = new Date(entryDate);
  if (Number.isNaN(when.getTime())) return { ok: false, error: "Deposit date is not valid" };
  if (when < cashbookStartDate()) {
    return {
      ok: false,
      error: `Deposit date is before the cash book start (${cashbookStartDate().toISOString().slice(0, 10)})`,
    };
  }
  if (!accountNumber) return { ok: false, error: "Bank account is required" };
  if (!employeeId || !mongoose.Types.ObjectId.isValid(String(employeeId))) {
    return { ok: false, error: "Select the employee whose cash is being deposited" };
  }
  const photos = cleanPhotos(slipPhotos);
  if (!photos.length) {
    return { ok: false, error: "Attach a photo of the deposit slip" };
  }

  const inHand = await cashInHandOf(employeeId);
  if (inHand == null || value - inHand > AMOUNT_EPS) {
    return {
      ok: false,
      code: "EXCEEDS_CASH_IN_HAND",
      error: `Deposit ${formatInr(value)} is more than this employee's cash in hand (${formatInr(Math.max(0, inHand || 0))})`,
      cashInHand: inHand || 0,
    };
  }

  const deposit = await CashBook.create({
    entryDate: when,
    entryType: "CASH_IN",
    amount: value,
    accountNumber: String(accountNumber).trim(),
    slipNumber: slipNumber ? String(slipNumber).trim() : "",
    narration: narration || "",
    reference: slipNumber ? String(slipNumber).trim() : "",
    depositVerified: false,
    depositedBy: employeeId,
    slipPhotos: photos,
    createdBy: userId || null,
  });

  log().info("Cash deposit recorded", {
    id: String(deposit._id),
    amount: value,
    accountNumber,
    employeeId: String(employeeId),
  });
  return { ok: true, deposit: deposit.toObject(), cashInHandAfter: Math.round((inHand - value) * 100) / 100 };
}

export async function listCashDeposits({
  accountNumber,
  dateFrom,
  dateTo,
  verified,
  employeeId,
  includeCancelled = false,
  limit = 200,
} = {}) {
  const filter = { entryType: "CASH_IN" };
  if (!includeCancelled) filter.cancelledAt = null;
  if (accountNumber) filter.accountNumber = accountNumber;
  if (employeeId && mongoose.Types.ObjectId.isValid(String(employeeId))) {
    filter.depositedBy = employeeId;
  }
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
    .populate("depositedBy", "name phoneNumber jobTitle role")
    .populate("createdBy", "name")
    .lean()
    .exec();
}

/** Undo a deposit entered by mistake. Matched deposits cannot be cancelled. */
export async function cancelCashDeposit(depositId, { userId, reason } = {}) {
  const deposit = await CashBook.findById(depositId);
  if (!deposit || deposit.entryType !== "CASH_IN") {
    return { ok: false, code: "NOT_FOUND", error: "Cash deposit not found" };
  }
  if (deposit.cancelledAt) return { ok: true, deposit: deposit.toObject(), alreadyCancelled: true };
  if (deposit.depositVerified) {
    return { ok: false, error: "This deposit is already matched to a bank credit and cannot be cancelled" };
  }
  deposit.cancelledAt = new Date();
  deposit.cancelledBy = userId || null;
  deposit.cancelReason = String(reason || "").trim();
  await deposit.save();
  log().info("Cash deposit cancelled", { id: String(deposit._id) });
  return { ok: true, deposit: deposit.toObject() };
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
  if (deposit.cancelledAt) return { ok: false, error: "This deposit was cancelled" };
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
