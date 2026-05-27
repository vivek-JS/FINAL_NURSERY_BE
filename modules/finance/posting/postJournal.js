import mongoose from "mongoose";
import FinanceVoucher from "../ledger/models/financeVoucher.model.js";
import JournalEntry from "../ledger/models/journalEntry.model.js";
import LedgerLine from "../ledger/models/ledgerLine.model.js";
import { requireAccountByCode } from "../coa/accountResolver.js";
import { assertPeriodOpen, periodKeyFromDate } from "./fiscalPeriod.js";
import { generateJournalNo } from "./voucherNumber.js";
import { VOUCHER_STATUS } from "../domain/constants.js";

/**
 * Post balanced journal lines for an existing voucher.
 * @param {Object} params
 * @param {import('mongoose').Types.ObjectId} params.voucherId
 * @param {import('./journalBuilder.js').JournalLineDraft[]} params.lines
 * @param {Date} params.entryDate
 * @param {string} [params.branchId]
 * @param {string} [params.tenantId]
 * @param {import('mongoose').ClientSession} [params.session]
 * @param {import('mongoose').Types.ObjectId} [params.postedBy]
 * @param {import('mongoose').Types.ObjectId} [params.reversalOfJournalId]
 */
export async function postJournal({
  voucherId,
  lines,
  entryDate,
  branchId = "default",
  tenantId = "default",
  session: externalSession,
  postedBy,
  reversalOfJournalId,
}) {
  if (!lines?.length) throw new Error("postJournal requires lines");

  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of lines) {
    totalDebit += l.debit || 0;
    totalCredit += l.credit || 0;
  }
  totalDebit = Math.round(totalDebit * 100) / 100;
  totalCredit = Math.round(totalCredit * 100) / 100;
  if (totalDebit !== totalCredit) {
    throw new Error(`Journal not balanced: debit=${totalDebit} credit=${totalCredit}`);
  }

  await assertPeriodOpen(entryDate, tenantId);

  const run = async (session) => {
    const voucher = await FinanceVoucher.findById(voucherId).session(session);
    if (!voucher) throw new Error("Voucher not found");
    if (voucher.status === VOUCHER_STATUS.POSTED && voucher.postedJournalId) {
      const existing = await JournalEntry.findById(voucher.postedJournalId).session(session);
      return { journalEntry: existing, voucher, duplicate: true };
    }

    const journalNo = await generateJournalNo(tenantId);
    const journalPayload = {
      tenantId,
      journalNo,
      voucherId: voucher._id,
      entryDate: new Date(entryDate),
      fiscalPeriod: periodKeyFromDate(entryDate),
      branchId,
      totalDebit,
      totalCredit,
      isBalanced: true,
      reversalOfJournalId: reversalOfJournalId || undefined,
      description: voucher.description,
      postedBy,
    };

    const [journalEntry] = await JournalEntry.create([journalPayload], { session });

    const lineDocs = [];
    for (const l of lines) {
      const account = await requireAccountByCode(l.accountCode, tenantId, session);
      lineDocs.push({
        tenantId,
        journalEntryId: journalEntry._id,
        accountId: account._id,
        accountCode: account.code,
        debit: l.debit || 0,
        credit: l.credit || 0,
        branchId,
        entryDate: new Date(entryDate),
        partyType: l.partyType,
        partyId: l.partyId,
        sourceLineRef: l.sourceLineRef,
        reversalOfLineId: l.reversalOfLineId,
        metadata: l.metadata,
      });
    }
    await LedgerLine.insertMany(lineDocs, { session });

    voucher.status = VOUCHER_STATUS.POSTED;
    voucher.postedJournalId = journalEntry._id;
    voucher.amountTotal = totalDebit;
    await voucher.save({ session });

    return { journalEntry, voucher, duplicate: false };
  };

  if (externalSession) {
    return run(externalSession);
  }

  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const result = await run(session);
    await session.commitTransaction();
    return result;
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
}

/**
 * Create voucher + post in one transaction.
 */
export async function createAndPostVoucher({
  voucherDraft,
  lines,
  session: externalSession,
}) {
  const run = async (session) => {
    const [voucher] = await FinanceVoucher.create([voucherDraft], { session });
    const result = await postJournal({
      voucherId: voucher._id,
      lines,
      entryDate: voucherDraft.entryDate,
      branchId: voucherDraft.branchId,
      tenantId: voucherDraft.tenantId,
      session,
      postedBy: voucherDraft.createdBy,
    });
    return { ...result, voucher };
  };

  if (externalSession) return run(externalSession);

  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const result = await run(session);
    await session.commitTransaction();
    return result;
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
}
