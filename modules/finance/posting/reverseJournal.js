import mongoose from "mongoose";
import JournalEntry from "../ledger/models/journalEntry.model.js";
import LedgerLine from "../ledger/models/ledgerLine.model.js";
import FinanceVoucher from "../ledger/models/financeVoucher.model.js";
import { generateVoucherNo } from "./voucherNumber.js";
import { postJournal } from "./postJournal.js";
import { VOUCHER_STATUS, VOUCHER_TYPES } from "../domain/constants.js";

/**
 * Reverse a posted journal by creating mirror lines on a new reversal voucher.
 */
export async function reverseJournal({
  journalEntryId,
  reason,
  tenantId = "default",
  postedBy,
  session: externalSession,
}) {
  const run = async (session) => {
    const original = await JournalEntry.findById(journalEntryId).session(session);
    if (!original) throw new Error("Journal entry not found");

    const origLines = await LedgerLine.find({ journalEntryId: original._id })
      .session(session)
      .lean();

    const origVoucher = await FinanceVoucher.findById(original.voucherId).session(session);
    if (!origVoucher) throw new Error("Original voucher not found");

    const voucherNo = await generateVoucherNo(VOUCHER_TYPES.REVERSAL, tenantId);
    const [reversalVoucher] = await FinanceVoucher.create(
      [
        {
          tenantId,
          voucherNo,
          voucherType: VOUCHER_TYPES.REVERSAL,
          status: VOUCHER_STATUS.DRAFT,
          branchId: original.branchId,
          entryDate: new Date(),
          partyType: origVoucher.partyType,
          partyId: origVoucher.partyId,
          description: reason || `Reversal of ${original.journalNo}`,
          sourceDomain: origVoucher.sourceDomain,
          sourceRefs: origVoucher.sourceRefs,
          reversalVoucherId: origVoucher._id,
          createdBy: postedBy,
          metadata: { reversalOfJournalId: original._id },
        },
      ],
      { session }
    );

    const mirrorLines = origLines.map((l) => ({
      accountCode: l.accountCode,
      debit: l.credit,
      credit: l.debit,
      partyType: l.partyType,
      partyId: l.partyId,
      sourceLineRef: l.sourceLineRef ? `rev:${l.sourceLineRef}` : undefined,
      reversalOfLineId: l._id,
      metadata: { ...(l.metadata || {}), reversalReason: reason },
    }));

    const result = await postJournal({
      voucherId: reversalVoucher._id,
      lines: mirrorLines,
      entryDate: new Date(),
      branchId: original.branchId,
      tenantId,
      session,
      postedBy,
      reversalOfJournalId: original._id,
    });

    origVoucher.status = VOUCHER_STATUS.REVERSED;
    await origVoucher.save({ session });

    return { ...result, reversalVoucher };
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
